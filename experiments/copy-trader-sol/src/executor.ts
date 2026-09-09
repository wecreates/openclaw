import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import { buildSwapTx, quote } from "./jupiter.js";
import { SOL_MINT, config } from "./config.js";
import { log } from "./log.js";
import { sendJitoBundle } from "./jito.js";
import { raceSend, raceSendersReady } from "./rpc.js";
import { incr } from "./metrics.js";

export type ExecResult = {
  signature: string | null;
  solLamports: number;
  tokenAmountRaw: bigint;
  pricePerToken: number;
  route: "dry" | "rpc" | "jito";
};

export async function buy(
  conn: Connection,
  kp: Keypair,
  tokenMint: string,
  solLamports: number,
): Promise<ExecResult> {
  return swap(conn, kp, SOL_MINT, tokenMint, BigInt(solLamports));
}

export async function sell(
  conn: Connection,
  kp: Keypair,
  tokenMint: string,
  amountRaw: bigint,
): Promise<ExecResult> {
  return swap(conn, kp, tokenMint, SOL_MINT, amountRaw);
}

async function swap(
  conn: Connection,
  kp: Keypair,
  inputMint: string,
  outputMint: string,
  amount: bigint,
): Promise<ExecResult> {
  const q = await quote({
    inputMint,
    outputMint,
    amount,
    slippageBps: config.slippageBps,
  });

  const solLamports =
    inputMint === SOL_MINT ? Number(q.inAmount) : Number(q.outAmount);
  const tokenAmountRaw = BigInt(
    inputMint === SOL_MINT ? q.outAmount : q.inAmount,
  );
  const pricePerToken =
    tokenAmountRaw > 0n ? solLamports / Number(tokenAmountRaw) : 0;

  if (config.dryRun) {
    log.info(
      { inputMint, outputMint, in: q.inAmount, out: q.outAmount, impact: q.priceImpactPct },
      "DRY_RUN quote",
    );
    incr("dryrun_quotes_total");
    return { signature: null, solLamports, tokenAmountRaw, pricePerToken, route: "dry" };
  }

  let priorityFee = config.priorityFeeMicrolamports;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < config.executionMaxAttempts; attempt++) {
    try {
      const b64 = await buildSwapTx({
        quote: q,
        userPublicKey: kp.publicKey.toBase58(),
        priorityFeeMicrolamports: priorityFee,
      });
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([kp]);

      if (config.jitoEnabled) {
        const { bundleId } = await sendJitoBundle(conn, kp, tx);
        incr("jito_bundles_total");
        return {
          signature: bundleId,
          solLamports,
          tokenAmountRaw,
          pricePerToken,
          route: "jito",
        };
      }

      const sig =
        raceSendersReady() > 0
          ? await raceSend(conn, tx)
          : await conn.sendRawTransaction(tx.serialize(), {
              skipPreflight: true,
              maxRetries: 3,
            });

      const bh = await conn.getLatestBlockhash();
      const conf = await conn.confirmTransaction(
        { signature: sig, ...bh },
        "confirmed",
      );
      if (conf.value.err) {
        throw new Error(`confirm err: ${JSON.stringify(conf.value.err)}`);
      }
      incr("rpc_swaps_total");
      return { signature: sig, solLamports, tokenAmountRaw, pricePerToken, route: "rpc" };
    } catch (err) {
      lastErr = err as Error;
      log.warn(
        { err: lastErr.message, attempt, priorityFee },
        "swap attempt failed",
      );
      incr("swap_retries_total");
      priorityFee = Math.min(priorityFee * 2, config.priorityFeeMicrolamportsMax);
    }
  }
  throw lastErr ?? new Error("swap failed after retries");
}
