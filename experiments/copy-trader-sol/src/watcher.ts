import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "./log.js";
import { detectSwapForWallet, type Swap } from "./parser.js";
import { markSeen } from "./state.js";

/**
 * Subscribe to logs mentioning each followed wallet with automatic reconnect
 * on WS failure. Yields at-most-once swaps via the seen_tx dedupe.
 */
export function watchWallets(
  conn: Connection,
  wallets: string[],
  onSwap: (s: Swap) => void | Promise<void>,
): () => Promise<void> {
  const subs = new Map<string, number>();
  let stopped = false;

  const subscribe = async (w: string): Promise<void> => {
    try {
      const id = conn.onLogs(
        new PublicKey(w),
        async (logsMsg) => {
          if (logsMsg.err) return;
          const sig = logsMsg.signature;
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
      subs.set(w, id);
      log.info({ wallet: w, subId: id }, "watching");
    } catch (err) {
      log.error({ err, wallet: w }, "subscribe failed");
      if (!stopped) scheduleResubscribe(w, 5000);
    }
  };

  const scheduleResubscribe = (w: string, delay: number): void => {
    setTimeout(() => {
      if (stopped) return;
      void subscribe(w);
    }, delay);
  };

  const attachHealthWatch = (): void => {
    let backoff = 1000;
    let missBeat = 0;
    setInterval(async () => {
      if (stopped) return;
      try {
        await conn.getSlot("confirmed");
        missBeat = 0;
        backoff = 1000;
      } catch (err) {
        missBeat++;
        log.warn({ err, missBeat }, "rpc heartbeat failed");
        if (missBeat >= 2) {
          log.warn("resubscribing all wallets after health check failure");
          for (const [w, id] of subs) {
            try {
              await conn.removeOnLogsListener(id);
            } catch { /* ignore */ }
            subs.delete(w);
            scheduleResubscribe(w, backoff);
          }
          backoff = Math.min(30_000, backoff * 2);
          missBeat = 0;
        }
      }
    }, 15_000).unref();
  };

  (async () => {
    for (const w of wallets) await subscribe(w);
    attachHealthWatch();
  })();

  return async () => {
    stopped = true;
    for (const id of subs.values()) {
      try { await conn.removeOnLogsListener(id); } catch { /* ignore */ }
    }
    subs.clear();
  };
}
