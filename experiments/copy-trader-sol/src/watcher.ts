import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "./log.js";
import { detectSwapForWallet, type Swap } from "./parser.js";
import { markSeen } from "./state.js";

/**
 * Subscribe to logs mentioning each followed wallet, then fetch and parse the tx.
 * Yields at-most-once swaps per (signature) via the `seen_tx` dedupe.
 */
export function watchWallets(
  conn: Connection,
  wallets: string[],
  onSwap: (s: Swap) => void | Promise<void>,
): () => Promise<void> {
  const subIds: number[] = [];

  for (const w of wallets) {
    const pk = new PublicKey(w);
    const id = conn.onLogs(
      pk,
      async (logs) => {
        if (logs.err) return;
        const sig = logs.signature;
        if (!markSeen(sig)) return;
        try {
          const tx = await conn.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });
          if (!tx) return;
          const swap = detectSwapForWallet(tx, w);
          if (!swap) return;
          log.info(
            { leader: w, side: swap.side, mint: swap.tokenMint, sig },
            "leader swap detected",
          );
          await onSwap(swap);
        } catch (err) {
          log.error({ err, sig }, "watcher parse error");
        }
      },
      "confirmed",
    );
    subIds.push(id);
    log.info({ wallet: w, subId: id }, "watching");
  }

  return async () => {
    for (const id of subIds) {
      try {
        await conn.removeOnLogsListener(id);
      } catch {
        /* ignore */
      }
    }
  };
}
