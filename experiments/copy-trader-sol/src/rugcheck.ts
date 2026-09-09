import { Connection, PublicKey } from "@solana/web3.js";
import { fetchJson } from "./http.js";
import { log } from "./log.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

export type RugReport = {
  mint: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  isMintable: boolean;
  isFreezable: boolean;
  topHolderPct: number | null;
  decimals: number;
  ok: boolean;
  reasons: string[];
};

/**
 * Checks that would let a token author rug or freeze the position.
 * Fast, on-chain only for authorities/decimals; top-holder concentration
 * is best-effort via a public API and falls back to null when unavailable.
 */
export async function rugCheck(
  conn: Connection,
  mint: string,
): Promise<RugReport> {
  const reasons: string[] = [];
  const pk = new PublicKey(mint);
  const info = await conn.getParsedAccountInfo(pk, "confirmed");
  const parsed = info.value?.data as
    | { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null; decimals?: number } } }
    | undefined;
  const p = parsed?.parsed?.info;
  const mintAuthorityRevoked = p?.mintAuthority == null;
  const freezeAuthorityRevoked = p?.freezeAuthority == null;
  const decimals = p?.decimals ?? 0;

  if (!mintAuthorityRevoked) reasons.push("mint authority not revoked (author can print more)");
  if (!freezeAuthorityRevoked) reasons.push("freeze authority not revoked (author can freeze your wallet)");

  let topHolderPct: number | null = null;
  try {
    const supply = await conn.getTokenSupply(pk, "confirmed");
    const total = Number(supply.value.amount);
    const largest = await conn.getTokenLargestAccounts(pk, "confirmed");
    const topRaw = largest.value[0]?.amount;
    if (topRaw && total > 0) {
      topHolderPct = (Number(topRaw) / total) * 100;
      if (topHolderPct > 20) {
        reasons.push(`top holder owns ${topHolderPct.toFixed(1)}% of supply`);
      }
    }
  } catch (err) {
    log.debug({ err, mint }, "rug: top holder query failed");
  }

  return {
    mint,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    isMintable: !mintAuthorityRevoked,
    isFreezable: !freezeAuthorityRevoked,
    topHolderPct,
    decimals,
    ok: reasons.length === 0,
    reasons,
  };
}

export function isBlockingRug(r: RugReport): boolean {
  return r.isFreezable || r.isMintable || (r.topHolderPct ?? 0) > 40;
}
