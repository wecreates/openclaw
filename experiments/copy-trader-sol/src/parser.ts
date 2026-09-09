import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { SOL_MINT } from "./config.js";

export type Swap = {
  leader: string;
  side: "buy" | "sell";
  tokenMint: string;
  solLamports: number;
  tokenAmountRaw: bigint;
  tokenDecimals: number;
  signature: string;
  slot: number;
};

/**
 * Detect a swap by diffing the leader's pre/post balances in a tx.
 * DEX-agnostic — works for Jupiter, Raydium, Pump.fun, Meteora, Orca, anything.
 *
 * Buy  = leader spent SOL and received an SPL token.
 * Sell = leader received SOL and sent an SPL token.
 */
export function detectSwapForWallet(
  tx: ParsedTransactionWithMeta,
  leader: string,
): Swap | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey.toBase58(),
  );
  const leaderIdx = accountKeys.indexOf(leader);
  if (leaderIdx < 0) return null;

  const feePayer = accountKeys[0];
  const preSol = meta.preBalances[leaderIdx] ?? 0;
  const postSol = meta.postBalances[leaderIdx] ?? 0;
  let solDelta = postSol - preSol;
  if (leader === feePayer) solDelta += meta.fee ?? 0;

  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const byMint = new Map<string, { delta: bigint; decimals: number }>();

  const collect = (
    entries: typeof pre,
    sign: 1 | -1,
  ): void => {
    for (const b of entries) {
      if (b.owner !== leader) continue;
      const mint = b.mint;
      if (mint === SOL_MINT) continue;
      const raw = BigInt(b.uiTokenAmount.amount);
      const prev = byMint.get(mint) ?? {
        delta: 0n,
        decimals: b.uiTokenAmount.decimals,
      };
      prev.delta += sign === 1 ? raw : -raw;
      prev.decimals = b.uiTokenAmount.decimals;
      byMint.set(mint, prev);
    }
  };
  collect(post, 1);
  collect(pre, -1);

  let candidate: { mint: string; delta: bigint; decimals: number } | null =
    null;
  for (const [mint, v] of byMint) {
    if (v.delta === 0n) continue;
    if (!candidate || (v.delta < 0n ? -v.delta : v.delta) >
        (candidate.delta < 0n ? -candidate.delta : candidate.delta)) {
      candidate = { mint, ...v };
    }
  }
  if (!candidate) return null;

  const boughtToken = candidate.delta > 0n && solDelta < 0;
  const soldToken = candidate.delta < 0n && solDelta > 0;
  if (!boughtToken && !soldToken) return null;

  return {
    leader,
    side: boughtToken ? "buy" : "sell",
    tokenMint: candidate.mint,
    solLamports: Math.abs(solDelta),
    tokenAmountRaw:
      candidate.delta < 0n ? -candidate.delta : candidate.delta,
    tokenDecimals: candidate.decimals,
    signature: tx.transaction.signatures[0] ?? "",
    slot: tx.slot,
  };
}
