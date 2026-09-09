import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { SOL_MINT } from "./config.js";

export type Swap = {
  leader: string;
  side: "buy" | "sell";
  tokenMint: string;
  solLamports: number;
  tokenAmountRaw: bigint;
  tokenDecimals: number;
  leaderPreTokenAmount: bigint;
  leaderPostTokenAmount: bigint;
  signature: string;
  slot: number;
};

/**
 * Detect a swap by diffing the leader's pre/post balances in a tx.
 * DEX-agnostic — works for Jupiter, Raydium, Pump.fun, Meteora, Orca.
 *
 * Buy  = leader spent SOL and received an SPL token.
 * Sell = leader received SOL and sent an SPL token.
 * Also carries leader's pre/post token balance so callers can size partial sells.
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
  type Snapshot = { amount: bigint; decimals: number };
  const preByMint = new Map<string, Snapshot>();
  const postByMint = new Map<string, Snapshot>();

  const fill = (
    entries: typeof pre,
    dest: Map<string, Snapshot>,
  ): void => {
    for (const b of entries) {
      if (b.owner !== leader) continue;
      if (b.mint === SOL_MINT) continue;
      const amount = BigInt(b.uiTokenAmount.amount);
      const prev = dest.get(b.mint);
      if (prev) prev.amount += amount;
      else dest.set(b.mint, { amount, decimals: b.uiTokenAmount.decimals });
    }
  };
  fill(pre, preByMint);
  fill(post, postByMint);

  const mints = new Set([...preByMint.keys(), ...postByMint.keys()]);
  let candidate: {
    mint: string;
    delta: bigint;
    decimals: number;
    preAmount: bigint;
    postAmount: bigint;
  } | null = null;
  for (const mint of mints) {
    const preSnap = preByMint.get(mint);
    const postSnap = postByMint.get(mint);
    const preAmount = preSnap?.amount ?? 0n;
    const postAmount = postSnap?.amount ?? 0n;
    const delta = postAmount - preAmount;
    if (delta === 0n) continue;
    const decimals = (postSnap ?? preSnap)!.decimals;
    const absDelta = delta < 0n ? -delta : delta;
    const absCandidate = candidate ? (candidate.delta < 0n ? -candidate.delta : candidate.delta) : 0n;
    if (!candidate || absDelta > absCandidate) {
      candidate = { mint, delta, decimals, preAmount, postAmount };
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
    tokenAmountRaw: candidate.delta < 0n ? -candidate.delta : candidate.delta,
    tokenDecimals: candidate.decimals,
    leaderPreTokenAmount: candidate.preAmount,
    leaderPostTokenAmount: candidate.postAmount,
    signature: tx.transaction.signatures[0] ?? "",
    slot: tx.slot,
  };
}
