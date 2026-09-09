import { fetchJson } from "./http.js";
import { log } from "./log.js";

const GT_BASE = "https://api.geckoterminal.com/api/v2";

type PoolResp = {
  data?: Array<{
    id?: string;
    attributes?: { address?: string; reserve_in_usd?: string };
  }>;
};

type OHLCV = [number, number, number, number, number, number];
type OhlcvResp = {
  data?: { attributes?: { ohlcv_list?: OHLCV[] } };
};

const poolCache = new Map<string, string | null>();

/**
 * Find the deepest Solana pool for a given mint via GeckoTerminal.
 * Returns null when nothing is found. Cached in-process.
 */
export async function findPoolAddress(mint: string): Promise<string | null> {
  if (poolCache.has(mint)) return poolCache.get(mint)!;
  try {
    const j = await fetchJson<PoolResp>(
      `${GT_BASE}/networks/solana/tokens/${mint}/pools?page=1`,
      { retries: 2, timeoutMs: 6000 },
    );
    const pools = j.data ?? [];
    if (pools.length === 0) { poolCache.set(mint, null); return null; }
    // Deepest reserve first.
    pools.sort((a, b) => {
      const av = Number(a.attributes?.reserve_in_usd ?? 0);
      const bv = Number(b.attributes?.reserve_in_usd ?? 0);
      return bv - av;
    });
    const addr = pools[0]?.attributes?.address ?? null;
    poolCache.set(mint, addr);
    return addr;
  } catch (err) {
    log.debug({ err: (err as Error).message, mint }, "gt pool lookup failed");
    poolCache.set(mint, null);
    return null;
  }
}

export type Candle = { t: number; o: number; h: number; l: number; c: number; vol: number };

/**
 * OHLCV history for a pool. `timeframe` is 'minute'|'hour'|'day'. Returns
 * newest-first from GeckoTerminal; we sort oldest-first for easier lookups.
 */
export async function ohlcv(
  poolAddress: string,
  timeframe: "minute" | "hour" | "day",
  aggregate: 1 | 5 | 15 | 30 = 1,
  beforeUnix?: number,
): Promise<Candle[]> {
  const url = new URL(
    `${GT_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}`,
  );
  url.searchParams.set("aggregate", String(aggregate));
  url.searchParams.set("limit", "1000");
  if (beforeUnix) url.searchParams.set("before_timestamp", String(beforeUnix));
  try {
    const j = await fetchJson<OhlcvResp>(url.toString(), { retries: 2, timeoutMs: 8000 });
    const rows = j.data?.attributes?.ohlcv_list ?? [];
    return rows
      .map((r) => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], vol: r[5] }))
      .sort((a, b) => a.t - b.t);
  } catch (err) {
    log.debug({ err: (err as Error).message, pool: poolAddress }, "gt ohlcv failed");
    return [];
  }
}

/**
 * Price at a given wall-clock timestamp (ms). Picks the closing price of the
 * candle whose window contains `ts`. Returns null if we can't get a candle.
 */
export async function priceAt(
  mint: string,
  ts: number,
): Promise<number | null> {
  const pool = await findPoolAddress(mint);
  if (!pool) return null;
  const candles = await ohlcv(pool, "minute", 1, Math.floor(ts / 1000) + 60);
  if (candles.length === 0) return null;
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.t <= ts) best = c;
    else break;
  }
  return (best ?? candles[0])!.c;
}
