import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type MessageV0,
} from "@solana/web3.js";
import { fetchJson } from "./http.js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Jito block-engine tip accounts (one is picked at random per submit).
 * These are documented at https://jito-labs.gitbook.io/mev/searcher-resources/bundles/tip-accounts
 */
const TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pivKeVBBjNhCJUpq3fx4",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

function pickTip(): PublicKey {
  return new PublicKey(
    TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]!,
  );
}

/**
 * Submits a signed VersionedTransaction as a Jito bundle with a tip.
 * Bundles land or don't — no partial fills, no MEV sandwiching against you.
 * Returns bundle id (not the tx signature; look up landed txs via the RPC).
 */
export async function sendJitoBundle(
  conn: Connection,
  kp: Keypair,
  signedTx: VersionedTransaction,
): Promise<{ bundleId: string; txSig: string }> {
  const tipLamports = config.jitoTipLamports;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  const tipIx = SystemProgram.transfer({
    fromPubkey: kp.publicKey,
    toPubkey: pickTip(),
    lamports: tipLamports,
  });

  const tipMsg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipIx],
  }).compileToV0Message();
  const tipTx = new VersionedTransaction(tipMsg);
  tipTx.sign([kp]);

  const b64 = (t: VersionedTransaction) =>
    Buffer.from(t.serialize()).toString("base64");

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendBundle",
    params: [[b64(signedTx), b64(tipTx)], { encoding: "base64" }],
  };

  const res = await fetchJson<{ result?: string; error?: { message?: string } }>(
    config.jitoBlockEngineUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      retries: 2,
      timeoutMs: 8000,
    },
  );
  if (res.error) throw new Error(`jito sendBundle: ${res.error.message}`);
  const bundleId = res.result ?? "";
  const txSig = Buffer.from(signedTx.signatures[0]!).toString("base64");
  log.info({ bundleId, tipLamports }, "jito bundle submitted");
  return { bundleId, txSig };
}

/** Look up a bundle's landing status. Returns null while pending. */
export async function bundleStatus(
  bundleId: string,
): Promise<"Landed" | "Failed" | "Invalid" | "Pending" | null> {
  try {
    const res = await fetchJson<{
      result?: { value?: { bundle_id: string; status: string }[] };
    }>(config.jitoBlockEngineUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getInflightBundleStatuses",
        params: [[bundleId]],
      }),
      retries: 1,
      timeoutMs: 4000,
    });
    const row = res.result?.value?.[0];
    if (!row) return null;
    return (row.status as any) ?? "Pending";
  } catch {
    return null;
  }
}
