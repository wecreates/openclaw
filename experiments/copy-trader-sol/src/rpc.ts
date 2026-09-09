import { Connection, VersionedTransaction } from "@solana/web3.js";
import { config } from "./config.js";
import { log } from "./log.js";

const extraRpcs = (process.env.EXTRA_RPC_URLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const senderConns: Connection[] = extraRpcs.map(
  (url) => new Connection(url, { commitment: "confirmed" }),
);

/**
 * Send the same signed tx to the primary RPC and every EXTRA_RPC_URL in
 * parallel. Return the first signature that comes back — duplicate submissions
 * of the same signed tx are idempotent, so racing costs nothing but latency.
 */
export async function raceSend(
  primary: Connection,
  signedTx: VersionedTransaction,
): Promise<string> {
  const raw = signedTx.serialize();
  const submit = (c: Connection): Promise<string> =>
    c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 2 });
  const senders = [primary, ...senderConns];
  if (senders.length === 1) return submit(primary);
  return new Promise<string>((resolve, reject) => {
    let done = false;
    let errors = 0;
    for (const c of senders) {
      submit(c)
        .then((sig) => {
          if (done) return;
          done = true;
          resolve(sig);
        })
        .catch((err) => {
          errors++;
          log.debug({ err: (err as Error).message }, "rpc send lost race");
          if (errors === senders.length && !done) reject(err as Error);
        });
    }
  });
}

export function raceSendersReady(): number {
  return senderConns.length;
}
