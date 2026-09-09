import { readFileSync } from "node:fs";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { priceAt } from "./pricehistory.js";

/**
 * Historical backtest replay.
 *
 * Input: JSON array of leader swaps, oldest first:
 *   [{ ts, leader, mint, side, leaderSol, leaderTokenAmount, leaderPreTokenAmount? }, ...]
 *
 * For each buy we simulate:
 *   - a stop-loss / trailing take-profit / max-age exit tracked candle-by-candle
 *   - a leader-sell exit when the leader's own sell arrives in the tape
 * Prices come from GeckoTerminal minute candles — closes at the tick's ts.
 *
 * Reported PnL is realistic within the fidelity of minute candles and
 * ignores slippage/gas (add SLIPPAGE_BPS + priority fee bounds if you want
 * a pessimistic bound).
 */

type LeaderSwap = {
  ts: number;
  leader: string;
  mint: string;
  side: "buy" | "sell";
  leaderSol: number;
  leaderTokenAmount: number;
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
  maxPositionAgeHours: number;
  priceCheckIntervalSec: number;
};

type Position = {
  mint: string; leader: string;
  entryPrice: number; peak: number;
  amount: number; solSpent: number;
  openedAtMs: number;
};

type ClosedTrade = {
  mint: string; leader: string;
  entryTs: number; exitTs: number;
  entryPrice: number; exitPrice: number;
  solSpent: number; solReceived: number;
  pnlSol: number; pnlPct: number;
  exitReason: string;
};

export async function backtestHistorical(
  swaps: LeaderSwap[],
  opts: BtOpts,
): Promise<{
  trades: number; buys: number; sells: number;
  skips: Record<string, number>;
  closed: ClosedTrade[];
  netSol: number; winRate: number;
  bestSol: number; worstSol: number;
  maxDrawdownSol: number;
  finalOpen: number;
}> {
  const positions = new Map<string, Position>();
  const cooldownMint = new Map<string, number>();
  const cooldownLeader = new Map<string, number>();
  const skips: Record<string, number> = {};
  const bump = (k: string): void => { skips[k] = (skips[k] ?? 0) + 1; };
  const closed: ClosedTrade[] = [];

  let buys = 0, sells = 0;
  let netSol = 0, peakEquity = 0, worstDrawdown = 0;

  // Sort swaps chronologically; guard against unsorted input.
  const tape = [...swaps].sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < tape.length; i++) {
    const s = tape[i]!;
    const key = `${s.mint}|${s.leader}`;

    // Between-swap tick: run price watch on open positions up to `s.ts`.
    await tickPositions(positions, s.ts, opts, closed, (pnl) => {
      netSol += pnl / LAMPORTS_PER_SOL;
      const eq = netSol;
      if (eq > peakEquity) peakEquity = eq;
      const dd = peakEquity - eq;
      if (dd > worstDrawdown) worstDrawdown = dd;
    });

    if (s.side === "buy") {
      if (positions.size >= opts.maxPositions) { bump("max_positions"); continue; }
      if (s.leaderSol < opts.minLeaderSol) { bump("leader_too_small"); continue; }
      if ((cooldownMint.get(s.mint) ?? 0) > s.ts) { bump("mint_cooldown"); continue; }
      if ((cooldownLeader.get(s.leader) ?? 0) > s.ts) { bump("leader_cooldown"); continue; }

      const price = await priceAt(s.mint, s.ts);
      if (price === null || price <= 0) { bump("no_price"); continue; }

      const spent = Math.floor(opts.buySizeSol * LAMPORTS_PER_SOL);
      const amount = spent / (price * LAMPORTS_PER_SOL);
      positions.set(key, {
        mint: s.mint, leader: s.leader,
        entryPrice: price, peak: price,
        amount, solSpent: spent, openedAtMs: s.ts,
      });
      cooldownLeader.set(s.leader, s.ts + opts.leaderCooldownMin * 60_000);
      buys++;
    } else {
      const pos = positions.get(key);
      if (!pos) { bump("no_position"); continue; }
      const price = await priceAt(s.mint, s.ts) ?? pos.entryPrice;
      const solReceived = Math.floor(price * pos.amount * LAMPORTS_PER_SOL);
      const pnl = solReceived - pos.solSpent;
      closeAndRecord(pos, price, s.ts, solReceived, "follow-leader-sell", closed);
      netSol += pnl / LAMPORTS_PER_SOL;
      const eq = netSol;
      if (eq > peakEquity) peakEquity = eq;
      const dd = peakEquity - eq;
      if (dd > worstDrawdown) worstDrawdown = dd;
      positions.delete(key);
      cooldownMint.set(s.mint, s.ts + opts.mintCooldownMin * 60_000);
      sells++;
    }
  }

  const wins = closed.filter((c) => c.pnlSol > 0).length;
  const winRate = closed.length > 0 ? wins / closed.length : 0;
  const bestSol = closed.reduce((m, c) => Math.max(m, c.pnlSol), 0);
  const worstSol = closed.reduce((m, c) => Math.min(m, c.pnlSol), 0);
  return {
    trades: buys + sells, buys, sells, skips,
    closed, netSol, winRate,
    bestSol, worstSol,
    maxDrawdownSol: worstDrawdown,
    finalOpen: positions.size,
  };
}

async function tickPositions(
  positions: Map<string, Position>,
  untilTs: number,
  opts: BtOpts,
  closed: ClosedTrade[],
  onPnl: (lamports: number) => void,
): Promise<void> {
  const step = opts.priceCheckIntervalSec * 1000;
  for (const [key, pos] of [...positions]) {
    let t = pos.openedAtMs + step;
    while (t <= untilTs) {
      const p = await priceAt(pos.mint, t);
      if (p === null) { t += step * 30; continue; } // skip forward when no candles
      if (p > pos.peak) pos.peak = p;

      const pnlPct = (p - pos.entryPrice) / pos.entryPrice;
      const dd = (pos.peak - p) / pos.peak;
      const ageH = (t - pos.openedAtMs) / 3_600_000;

      let reason: string | null = null;
      if (opts.stopLossPct > 0 && pnlPct <= -opts.stopLossPct)
        reason = "stop-loss";
      else if (
        opts.takeProfitPct > 0 && pnlPct >= opts.takeProfitPct &&
        opts.trailingStopPct > 0 && dd >= opts.trailingStopPct
      )
        reason = "trailing-tp";
      else if (opts.maxPositionAgeHours > 0 && ageH >= opts.maxPositionAgeHours)
        reason = "max-age";

      if (reason) {
        const solReceived = Math.floor(p * pos.amount * LAMPORTS_PER_SOL);
        closeAndRecord(pos, p, t, solReceived, reason, closed);
        onPnl(solReceived - pos.solSpent);
        positions.delete(key);
        break;
      }
      t += step;
    }
  }
}

function closeAndRecord(
  pos: Position,
  exitPrice: number,
  exitTs: number,
  solReceived: number,
  reason: string,
  closed: ClosedTrade[],
): void {
  const pnlLamports = solReceived - pos.solSpent;
  closed.push({
    mint: pos.mint, leader: pos.leader,
    entryTs: pos.openedAtMs, exitTs,
    entryPrice: pos.entryPrice, exitPrice,
    solSpent: pos.solSpent / LAMPORTS_PER_SOL,
    solReceived: solReceived / LAMPORTS_PER_SOL,
    pnlSol: pnlLamports / LAMPORTS_PER_SOL,
    pnlPct: (exitPrice - pos.entryPrice) / pos.entryPrice,
    exitReason: reason,
  });
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: tsx src/backtest.ts <trades.json> [--size 0.02] [--stop 0.3] [--tp 1] [--trail 0.2] [--max-age 24]");
    process.exit(1);
  }
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
    maxPositionAgeHours: flag("max-age", 24),
    priceCheckIntervalSec: flag("tick", 60),
  };
  console.error(`replaying ${swaps.length} leader swaps with`, opts);
  const r = await backtestHistorical(swaps, opts);
  console.log(JSON.stringify(
    { ...r, closed: r.closed.slice(0, 20).concat(r.closed.length > 20 ? [{ _truncated: r.closed.length - 20 } as any] : []) },
    null, 2,
  ));
  console.error(`\nSummary: ${r.buys} buys · ${r.sells+r.closed.filter(c=>c.exitReason!=='follow-leader-sell').length} sells · net ${r.netSol.toFixed(4)} SOL · winrate ${(r.winRate*100).toFixed(0)}% · best +${r.bestSol.toFixed(4)} · worst ${r.worstSol.toFixed(4)} · max drawdown ${r.maxDrawdownSol.toFixed(4)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
