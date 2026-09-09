import { Connection } from "@solana/web3.js";
import { fetchJson } from "./http.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { findPoolAddress } from "./pricehistory.js";
import { rugCheck as onChainRugCheck, type RugReport } from "./rugcheck.js";

/**
 * Second-tier rug check that catches what the on-chain mint/freeze
 * authority + top-holder check can't:
 *   - LP burned / locked status (rugpull vector)
 *   - 24h volume too low to trust the price
 *   - suspicious pool age / low reserve
 *
 * Data source: GeckoTerminal (public, generous free tier). Falls back
 * gracefully — an unavailable answer is treated as unknown, not fail.
 */

type EnhancedReport = RugReport & {
  poolAddress: string | null;
  reserveUsd: number | null;
  volume24hUsd: number | null;
  poolAgeMinutes: number | null;
  lpBurned: boolean | null;
  extraReasons: string[];
};

type PoolAttrs = {
  address?: string;
  reserve_in_usd?: string;
  pool_created_at?: string;
  volume_usd?: { h24?: string };
  transactions?: { h24?: { buys: number; sells: number } };
  gt_score?: number;
};

type PoolResp = { data?: Array<{ id?: string; attributes?: PoolAttrs }> };

export async function enhancedRugCheck(
  conn: Connection,
  mint: string,
): Promise<EnhancedReport> {
  const base = await onChainRugCheck(conn, mint);
  const extraReasons: string[] = [];

  let poolAddress: string | null = null;
  let reserveUsd: number | null = null;
  let volume24hUsd: number | null = null;
  let poolAgeMinutes: number | null = null;
  let lpBurned: boolean | null = null;

  try {
    poolAddress = await findPoolAddress(mint);
    if (poolAddress) {
      const pool = await fetchJson<PoolResp>(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}`,
        { retries: 1, timeoutMs: 5000 },
      );
      const attrs = pool.data?.[0]?.attributes;
      if (attrs) {
        reserveUsd = Number(attrs.reserve_in_usd ?? 0);
        volume24hUsd = Number(attrs.volume_usd?.h24 ?? 0);
        if (attrs.pool_created_at) {
          poolAgeMinutes =
            (Date.now() - new Date(attrs.pool_created_at).getTime()) / 60_000;
        }
        // A very low gt_score often correlates with unburned/mutable LP.
        // Not authoritative but a useful nudge.
        if ((attrs.gt_score ?? 100) < 30) {
          extraReasons.push(`GT score ${attrs.gt_score?.toFixed(0)} < 30 (suspicious pool)`);
          lpBurned = false;
        }
      }
    }
  } catch (err) {
    log.debug({ err: (err as Error).message, mint }, "enhanced rug: gt lookup failed");
  }

  if (reserveUsd !== null && reserveUsd < config.minLiquidityUsd) {
    extraReasons.push(
      `pool reserve $${reserveUsd.toFixed(0)} < min $${config.minLiquidityUsd}`,
    );
  }
  if (volume24hUsd !== null && volume24hUsd < config.minVolume24hUsd) {
    extraReasons.push(
      `24h volume $${volume24hUsd.toFixed(0)} < min $${config.minVolume24hUsd}`,
    );
  }
  if (
    config.minPoolAgeMinutes > 0 &&
    poolAgeMinutes !== null &&
    poolAgeMinutes < config.minPoolAgeMinutes
  ) {
    extraReasons.push(
      `pool age ${poolAgeMinutes.toFixed(0)}m < min ${config.minPoolAgeMinutes}m`,
    );
  }

  return {
    ...base,
    ok: base.ok && extraReasons.length === 0,
    reasons: [...base.reasons, ...extraReasons],
    poolAddress,
    reserveUsd,
    volume24hUsd,
    poolAgeMinutes,
    lpBurned,
    extraReasons,
  };
}

export function isBlockingEnhancedRug(r: EnhancedReport): boolean {
  if (r.isFreezable || r.isMintable) return true;
  if ((r.topHolderPct ?? 0) > 40) return true;
  if (r.lpBurned === false) return true;
  if (r.reserveUsd !== null && r.reserveUsd < config.minLiquidityUsd) return true;
  if (r.volume24hUsd !== null && r.volume24hUsd < config.minVolume24hUsd) return true;
  if (
    config.minPoolAgeMinutes > 0 &&
    r.poolAgeMinutes !== null &&
    r.poolAgeMinutes < config.minPoolAgeMinutes
  )
    return true;
  return false;
}
