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
import { clearPending, recordPending } from "./pendingswap.js";

export type ExecResult = {
  signature: string | null;
  solLamports: number;
  tokenAmountRaw: bigint;
  pricePerToken: number;
  actualFillPrice: number;
  slippageBps: number;
  route: "dry" | "rpc" | "jito";
};

export async function buy(
  conn: Connection, kp: Keypair, tokenMint: string, solLamports: number,
): Promise<ExecResult> {
  return swap(conn, kp, SOL_MINT, tokenMint, BigInt(solLamports), null);
}

export async function sell(
  conn: Connection, kp: Keypair, tokenMint: string, amountRaw: bigint,
): Promise<ExecResult> {
  return swap(conn, kp, tokenMint, SOL_MINT, amountRaw, null);
}

async function swap(
  conn: Connection, kp: Keypair,
  inputMint: string, outputMint: string, amount: bigint,
  leader: string | null,
): Promise<ExecResult> {
  const q = await quote({
    inputMint, outputMint, amount, slippageBps: config.slippageBps,
  });

  const quotedSol = inputMint === SOL_MINT ? Number(q.inAmount) : Number(q.outAmount);
  const quotedTokenRaw = BigInt(inputMint === SOL_MINT ? q.outAmount : q.inAmount);
  const quotedPrice = quotedTokenRaw > 0n ? quotedSol / Number(quotedTokenRaw) : 0;

  if (config.dryRun) {
    log.info(
      { inputMint, outputMint, in: q.inAmount, out: q.outAmount, impact: q.priceImpactPct },
      "DRY_RUN quote",
    );
    incr("dryrun_quotes_total");
    return {
      signature: null,
      solLamports: quotedSol,
      tokenAmountRaw: quotedTokenRaw,
      pricePerToken: quotedPrice,
      actualFillPrice: quotedPrice,
      slippageBps: 0,
      route: "dry",
    };
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
      const sig = Buffer.from(tx.signatures[0]!).toString("base64");

      const bh = await conn.getLatestBlockhash("confirmed");
      recordPending({
        signature: sig,
        side: inputMint === SOL_MINT ? "buy" : "sell",
        inputMint, outputMint,
        inputAmount: amount.toString(),
        quoteOutAmount: (inputMint === SOL_MINT ? quotedTokenRaw : BigInt(quotedSol)).toString(),
        leader,
        sentAt: Date.now(),
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
      });

      let submittedSig: string;
      if (config.jitoEnabled) {
        const { bundleId } = await sendJitoBundle(conn, kp, tx);
        submittedSig = sig; // bundle can be looked up via getSignatureStatus
        incr("jito_bundles_total");
        log.info({ bundleId, sig }, "jito bundle submitted");
      } else {
        submittedSig =
          raceSendersReady() > 0
            ? await raceSend(conn, tx)
            : await conn.sendRawTransaction(tx.serialize(), {
                skipPreflight: true, maxRetries: 3,
              });
      }

      const conf = await conn.confirmTransaction(
        { signature: submittedSig, ...bh },
        "confirmed",
      );
      if (conf.value.err) {
        throw new Error(`confirm err: ${JSON.stringify(conf.value.err)}`);
      }

      const actual = await measureActualFill(conn, submittedSig, kp.publicKey.toBase58(), inputMint, outputMint);
      clearPending(sig);
      incr(config.jitoEnabled ? "jito_swaps_confirmed_total" : "rpc_swaps_total");

      const actualPrice = actual?.pricePerToken ?? quotedPrice;
      const actualSol = actual?.solLamports ?? quotedSol;
      const actualToken = actual?.tokenAmountRaw ?? quotedTokenRaw;
      const slippageBps =
        quotedPrice > 0
          ? Math.round(Math.abs((actualPrice - quotedPrice) / quotedPrice) * 10_000)
          : 0;
      if (slippageBps > config.slippageBps) {
        log.warn(
          { quotedPrice, actualPrice, slippageBps, tolerance: config.slippageBps },
          "fill slipped past tolerance (settled anyway)",
        );
        incr("slippage_overrun_total");
      }

      return {
        signature: submittedSig,
        solLamports: actualSol,
        tokenAmountRaw: actualToken,
        pricePerToken: quotedPrice,
        actualFillPrice: actualPrice,
        slippageBps,
        route: config.jitoEnabled ? "jito" : "rpc",
      };
    } catch (err) {
      lastErr = err as Error;
      log.warn({ err: lastErr.message, attempt, priorityFee }, "swap attempt failed");
      incr("swap_retries_total");
      priorityFee = Math.min(priorityFee * 2, config.priorityFeeMicrolamportsMax);
    }
  }
  throw lastErr ?? new Error("swap failed after retries");
}

/**
 * Parse the confirmed tx and diff our own pre/post SPL + SOL balances to
 * measure the actual fill. Returns null when the tx isn't parseable yet
 * (rare — happens if the RPC is slower than confirmation).
 */
async function measureActualFill(
  conn: Connection,
  sig: string,
  ownerBase58: string,
  inputMint: string,
  outputMint: string,
): Promise<{ solLamports: number; tokenAmountRaw: bigint; pricePerToken: number } | null> {
  try {
    const tx = await conn.getParsedTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey.toBase58(),
    );
    const idx = keys.indexOf(ownerBase58);
    if (idx < 0) return null;
    const solDelta =
      (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0) +
      (keys[0] === ownerBase58 ? (tx.meta.fee ?? 0) : 0);

    const tokenMint = outputMint === SOL_MINT ? inputMint : outputMint;
    const preAmount = tokenBalance(tx.meta.preTokenBalances, ownerBase58, tokenMint);
    const postAmount = tokenBalance(tx.meta.postTokenBalances, ownerBase58, tokenMint);
    const tokenDelta = postAmount - preAmount;
    const absToken = tokenDelta < 0n ? -tokenDelta : tokenDelta;
    const absSol = Math.abs(solDelta);
    if (absToken === 0n || absSol === 0) return null;
    return {
      solLamports: absSol,
      tokenAmountRaw: absToken,
      pricePerToken: absSol / Number(absToken),
    };
  } catch {
    return null;
  }
}

function tokenBalance(
  entries: Array<{ owner?: string; mint: string; uiTokenAmount: { amount: string } }> | null | undefined,
  owner: string,
  mint: string,
): bigint {
  if (!entries) return 0n;
  let total = 0n;
  for (const e of entries) {
    if (e.owner === owner && e.mint === mint) {
      total += BigInt(e.uiTokenAmount.amount);
    }
  }
  return total;
}
