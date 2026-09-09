import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SOL_MINT, USDC_MINT } from "./config.js";
import { fetchJson } from "./http.js";
import { log } from "./log.js";

let cached: { usd: number; at: number } | null = null;
const TTL_MS = 60_000;

/**
 * SOL/USD spot from Jupiter's own quote endpoint (no extra API needed).
 * Cached for 60s. Returns 0 if the fetch fails — callers should handle it.
 */
export async function solUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.usd;
  try {
    const url = new URL("https://quote-api.jup.ag/v6/quote");
    url.searchParams.set("inputMint", SOL_MINT);
    url.searchParams.set("outputMint", USDC_MINT);
    url.searchParams.set("amount", String(LAMPORTS_PER_SOL));
    url.searchParams.set("slippageBps", "50");
    const q = await fetchJson<{ outAmount: string }>(url.toString(), {
      retries: 1,
      timeoutMs: 4000,
    });
    const usd = Number(q.outAmount) / 1e6;
    cached = { usd, at: Date.now() };
    return usd;
  } catch (err) {
    log.debug({ err: (err as Error).message }, "sol/usd fetch failed");
    return cached?.usd ?? 0;
  }
}

export function formatUsd(sol: number, price: number): string {
  if (price <= 0) return "";
  const usd = sol * price;
  const abs = Math.abs(usd);
  const s = abs >= 1000 ? usd.toFixed(0) : abs >= 1 ? usd.toFixed(2) : usd.toFixed(4);
  return `${usd >= 0 ? "+" : ""}$${s}`;
}
