import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { request } from "undici";
import { SOL_MINT, config } from "./config.js";
import { pnlLast24hLamports } from "./state.js";
import { log } from "./log.js";

const BLACKLIST = new Set<string>(
  (process.env.BLACKLIST_MINTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export function isBlacklisted(mint: string): boolean {
  return BLACKLIST.has(mint) || mint === SOL_MINT;
}

export function sizeBuyLamports(leaderSolLamports: number): number {
  if (config.fixedBuySol > 0) {
    return Math.floor(config.fixedBuySol * LAMPORTS_PER_SOL);
  }
  if (config.leaderPercent > 0) {
    return Math.floor(leaderSolLamports * (config.leaderPercent / 100));
  }
  return 0;
}

export function dailyLossExceeded(): boolean {
  const pnl = pnlLast24hLamports();
  const limit = Math.floor(config.dailyLossLimitSol * LAMPORTS_PER_SOL);
  if (pnl <= -limit) {
    log.warn({ pnlLamports: pnl, limitLamports: -limit }, "daily loss limit hit");
    return true;
  }
  return false;
}

/** Rough liquidity check via Jupiter's price API — skips if quote unavailable or impact too high. */
export async function passesLiquidity(mint: string): Promise<boolean> {
  try {
    const probe = Math.floor(0.1 * LAMPORTS_PER_SOL);
    const url = new URL("https://quote-api.jup.ag/v6/quote");
    url.searchParams.set("inputMint", SOL_MINT);
    url.searchParams.set("outputMint", mint);
    url.searchParams.set("amount", String(probe));
    url.searchParams.set("slippageBps", "300");
    const res = await request(url.toString());
    if (res.statusCode !== 200) return false;
    const q = (await res.body.json()) as { priceImpactPct: string };
    return Number(q.priceImpactPct) < 0.05;
  } catch {
    return false;
  }
}
