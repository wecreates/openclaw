import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { log } from "./log.js";

const cache = new Map<string, number>();

/**
 * Age of the mint account in milliseconds, from its first observed signature.
 * Cheap-ish: one `getSignaturesForAddress(mint, { limit: 1000 })` call, cached.
 * Returns null if we can't determine the age.
 */
export async function mintAgeMs(
  conn: Connection,
  mint: string,
): Promise<number | null> {
  const cached = cache.get(mint);
  if (cached !== undefined) return Date.now() - cached;

  try {
    const pk = new PublicKey(mint);
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 1000 }, "confirmed");
    if (sigs.length === 0) return null;
    let oldest = sigs[0]!;
    for (const s of sigs) {
      if ((s.blockTime ?? 0) > 0 && (s.blockTime ?? Infinity) < (oldest.blockTime ?? Infinity)) {
        oldest = s;
      }
    }
    if (!oldest.blockTime) return null;
    const createdAt = oldest.blockTime * 1000;
    cache.set(mint, createdAt);
    return Date.now() - createdAt;
  } catch (err) {
    log.debug({ err, mint }, "tokenage lookup failed");
    return null;
  }
}

/**
 * Returns `true` when the mint is old enough per config.
 * Unknown age is treated as too-young when strict mode is on.
 */
export async function passesTokenAge(
  conn: Connection,
  mint: string,
): Promise<{ ok: boolean; ageMinutes: number | null }> {
  if (config.minTokenAgeMinutes <= 0) return { ok: true, ageMinutes: null };
  const ageMs = await mintAgeMs(conn, mint);
  if (ageMs === null) {
    return { ok: !config.strictTokenAge, ageMinutes: null };
  }
  const ageMinutes = ageMs / 60_000;
  return { ok: ageMinutes >= config.minTokenAgeMinutes, ageMinutes };
}
