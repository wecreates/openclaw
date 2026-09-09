import { readFileSync } from "node:fs";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SOL_MINT } from "./config.js";
import { quote } from "./jupiter.js";

/**
 * Backtest replay.
 *
 * Input: a JSON file whose top-level is an array of leader swaps, oldest first:
 *   [{ ts, leader, mint, side, leaderSol, leaderTokenAmount, leaderPreTokenAmount? }, ...]
 *
 * We can't quote historical prices from Jupiter (it only serves the current
 * pool state), so this replay simulates:
 *   - buys at the *current* Jupiter quote for the token — useful for evaluating
 *     "would this leader's mix be liquid enough now that I could copy" and for
 *     dry-running risk rules
 *   - sells at the current quote — same caveat
 *
 * The value here is the strategy shape (what would have been sized, blocked
 * by min-notional / cooldowns / max positions, or auto-muted) not the actual
 * historical PnL. For real PnL you'd need a paid archival price feed
 * (Birdeye, GeckoTerminal, Jupiter Pro).
 *
 * Runs standalone: `pnpm tsx src/backtest.ts trades.json --size 0.02 --stop 0.3`
 */

type LeaderSwap = {
  ts: number;
  leader: string;
  mint: string;
  side: "buy" | "sell";
  leaderSol: number;
  leaderTokenAmount: number;
  leaderPreTokenAmount?: number;
};

type BtOpts = {
  buySizeSol: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  maxPositions: number;
  mintCooldownMin: number;
  leaderCooldownMin: number;
  minLeaderSol: number;
};

type Position = {
  mint: string; leader: string;
  entryPriceSolPerToken: number;
  peakPrice: number;
  amountRaw: bigint;
  solSpent: number;
  openedAtMs: number;
};

export async function backtest(
  swaps: LeaderSwap[],
  opts: BtOpts,
): Promise<{
  trades: number;
  buys: number;
  sells: number;
  skips: Record<string, number>;
  netSol: number;
  winRate: number;
  finalOpen: number;
}> {
  const positions = new Map<string, Position>();
  const cooldownMint = new Map<string, number>();
  const cooldownLeader = new Map<string, number>();
  const skips: Record<string, number> = {};
  const bump = (k: string) => (skips[k] = (skips[k] ?? 0) + 1);

  let buys = 0, sells = 0;
  let wins = 0, losses = 0;
  let netSol = 0;
  const nowMs = Date.now();

  for (const s of swaps) {
    const key = `${s.mint}|${s.leader}`;
    if (s.side === "buy") {
      if (positions.size >= opts.maxPositions) { bump("max_positions"); continue; }
      if (s.leaderSol < opts.minLeaderSol) { bump("leader_too_small"); continue; }
      if ((cooldownMint.get(s.mint) ?? 0) > s.ts) { bump("mint_cooldown"); continue; }
      if ((cooldownLeader.get(s.leader) ?? 0) > s.ts) { bump("leader_cooldown"); continue; }

      let q;
      try {
        q = await quote({
          inputMint: SOL_MINT,
          outputMint: s.mint,
          amount: BigInt(Math.floor(opts.buySizeSol * LAMPORTS_PER_SOL)),
          slippageBps: 150,
        });
      } catch { bump("quote_fail"); continue; }
      const tokenOut = BigInt(q.outAmount);
      if (tokenOut === 0n) { bump("zero_out"); continue; }
      const priceEntry = Number(q.inAmount) / Number(tokenOut);

      positions.set(key, {
        mint: s.mint,
        leader: s.leader,
        entryPriceSolPerToken: priceEntry,
        peakPrice: priceEntry,
        amountRaw: tokenOut,
        solSpent: Number(q.inAmount),
        openedAtMs: s.ts,
      });
      cooldownLeader.set(s.leader, s.ts + opts.leaderCooldownMin * 60_000);
      buys++;
    } else {
      const pos = positions.get(key);
      if (!pos) { bump("no_position"); continue; }
      let q;
      try {
        q = await quote({
          inputMint: s.mint,
          outputMint: SOL_MINT,
          amount: pos.amountRaw,
          slippageBps: 150,
        });
      } catch { bump("quote_fail_sell"); continue; }
      const proceeds = Number(q.outAmount);
      const pnl = proceeds - pos.solSpent;
      netSol += pnl / LAMPORTS_PER_SOL;
      if (pnl > 0) wins++; else losses++;
      positions.delete(key);
      cooldownMint.set(s.mint, s.ts + opts.mintCooldownMin * 60_000);
      sells++;
    }
  }

  const finalOpen = positions.size;
  const trades = buys + sells;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  return { trades, buys, sells, skips, netSol, winRate, finalOpen };
}

async function main() {
  const path = process.argv[2];
  if (!path) { console.error("usage: tsx src/backtest.ts <trades.json> [--size 0.02]"); process.exit(1); }
  const flag = (name: string, fallback: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
  };
  const swaps = JSON.parse(readFileSync(path, "utf8")) as LeaderSwap[];
  const opts: BtOpts = {
    buySizeSol: flag("size", 0.02),
    stopLossPct: flag("stop", 0.3),
    takeProfitPct: flag("tp", 1.0),
    trailingStopPct: flag("trail", 0.2),
    maxPositions: flag("max-positions", 5),
    mintCooldownMin: flag("mint-cd", 60),
    leaderCooldownMin: flag("leader-cd", 5),
    minLeaderSol: flag("min-leader-sol", 0.1) * LAMPORTS_PER_SOL,
  };
  console.log(`replaying ${swaps.length} leader swaps with`, opts);
  const r = await backtest(swaps, opts);
  console.log(JSON.stringify(r, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
