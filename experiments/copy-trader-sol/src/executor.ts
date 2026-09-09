import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import { buildSwapTx, quote } from "./jupiter.js";
import { SOL_MINT, config } from "./config.js";
import { log } from "./log.js";

export type ExecResult = {
  signature: string | null;
  solLamports: number;
  tokenAmountRaw: bigint;
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

  if (config.dryRun) {
    log.info(
      { inputMint, outputMint, in: q.inAmount, out: q.outAmount, impact: q.priceImpactPct },
      "DRY_RUN quote",
    );
    return {
      signature: null,
      solLamports: inputMint === SOL_MINT ? Number(q.inAmount) : Number(q.outAmount),
      tokenAmountRaw: BigInt(inputMint === SOL_MINT ? q.outAmount : q.inAmount),
    };
  }

  const b64 = await buildSwapTx({
    quote: q,
    userPublicKey: kp.publicKey.toBase58(),
    priorityFeeMicrolamports: config.priorityFeeMicrolamports,
  });

  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([kp]);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  log.info({ sig }, "swap sent");

  const conf = await conn.confirmTransaction(
    { signature: sig, ...(await conn.getLatestBlockhash()) },
    "confirmed",
  );
  if (conf.value.err) throw new Error(`swap failed: ${JSON.stringify(conf.value.err)}`);

  return {
    signature: sig,
    solLamports: inputMint === SOL_MINT ? Number(q.inAmount) : Number(q.outAmount),
    tokenAmountRaw: BigInt(inputMint === SOL_MINT ? q.outAmount : q.inAmount),
  };
}
