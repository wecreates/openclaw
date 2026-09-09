import { Connection, Keypair } from "@solana/web3.js";
import { SOL_MINT, config } from "./config.js";
import { quote } from "./jupiter.js";
import { sell as execSell } from "./executor.js";
import {
  closePosition,
  listPositions,
  recordTrade,
  updatePositionPrice,
  type Position,
} from "./state.js";
import { log } from "./log.js";
import { notify, fmtSol } from "./notify.js";
import { killSwitchTripped } from "./risk.js";

/**
 * Poll the current sell price for every open position and trigger a stop-loss
 * or trailing take-profit exit when thresholds fire.
 */
export function startPriceWatcher(conn: Connection, kp: Keypair): () => void {
  let stopped = false;
  const iv = setInterval(() => {
    if (stopped) return;
    void tick(conn, kp);
  }, config.priceCheckIntervalSec * 1000);
  return () => {
    stopped = true;
    clearInterval(iv);
  };
}

async function tick(conn: Connection, kp: Keypair): Promise<void> {
  if (killSwitchTripped()) return;
  const positions = listPositions();
  for (const p of positions) {
    try {
      await evaluatePosition(conn, kp, p);
    } catch (err) {
      log.warn({ err, mint: p.mint }, "price watch error");
    }
  }
}

async function evaluatePosition(
  conn: Connection,
  kp: Keypair,
  p: Position,
): Promise<void> {
  const amount = BigInt(p.amountRaw);
  if (amount <= 0n) return;

  let q;
  try {
    q = await quote({
      inputMint: p.mint,
      outputMint: SOL_MINT,
      amount,
      slippageBps: config.slippageBps,
    });
  } catch (err) {
    log.debug({ err, mint: p.mint }, "quote failed during price check");
    return;
  }
  const currentSol = Number(q.outAmount);
  const currentPrice = currentSol / Number(amount);
  const peak = Math.max(p.peakPriceSolPerToken, currentPrice);
  updatePositionPrice(p.mint, p.leader, currentPrice, peak);

  const entry = p.entryPriceSolPerToken;
  if (entry <= 0) return;

  const pnlPct = (currentPrice - entry) / entry;
  const drawdownFromPeak = (peak - currentPrice) / peak;
  const ageHours = (Date.now() - p.openedAt) / 3_600_000;

  let reason: string | null = null;
  if (config.stopLossPct > 0 && pnlPct <= -config.stopLossPct) {
    reason = `stop-loss ${(pnlPct * 100).toFixed(1)}%`;
  } else if (
    config.takeProfitPct > 0 &&
    pnlPct >= config.takeProfitPct &&
    config.trailingStopPct > 0 &&
    drawdownFromPeak >= config.trailingStopPct
  ) {
    reason = `trailing take-profit +${(pnlPct * 100).toFixed(1)}% (dropped ${(drawdownFromPeak * 100).toFixed(1)}% from peak)`;
  } else if (
    config.takeProfitPct > 0 &&
    config.trailingStopPct <= 0 &&
    pnlPct >= config.takeProfitPct
  ) {
    reason = `take-profit +${(pnlPct * 100).toFixed(1)}%`;
  } else if (
    config.maxPositionAgeHours > 0 &&
    ageHours >= config.maxPositionAgeHours
  ) {
    reason = `max-age ${ageHours.toFixed(1)}h`;
  }
  if (!reason) return;

  log.warn({ mint: p.mint, leader: p.leader, reason }, "auto-exit triggered");
  const res = await execSell(conn, kp, p.mint, amount);
  closePosition(p.mint, p.leader);
  recordTrade({
    side: "sell",
    mint: p.mint,
    leader: p.leader,
    solDeltaLamports: res.solLamports - p.solSpentLamports,
    txSig: res.signature,
    reason,
  });
  notify(
    `🛑 auto-exit *${p.mint.slice(0, 6)}…* (${reason})\nspent ${fmtSol(p.solSpentLamports)} → recv ${fmtSol(res.solLamports)} SOL`,
  );
}
