import Database from "better-sqlite3";
import { Connection } from "@solana/web3.js";
import { log } from "./log.js";
import { incr } from "./metrics.js";

const DB_PATH = process.env.DB_PATH ?? "./data/state.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

export type PendingSwap = {
  signature: string;
  side: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  quoteOutAmount: string;
  leader: string | null;
  sentAt: number;
  blockhash: string;
  lastValidBlockHeight: number | null;
};

export function recordPending(p: PendingSwap): void {
  db.prepare(
    `INSERT OR REPLACE INTO pending_swaps
       (signature, side, input_mint, output_mint, input_amount, quote_out_amount,
        leader, sent_at, blockhash, last_valid_block_height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.signature, p.side, p.inputMint, p.outputMint, p.inputAmount, p.quoteOutAmount,
    p.leader, p.sentAt, p.blockhash, p.lastValidBlockHeight,
  );
}

export function clearPending(signature: string): void {
  db.prepare(`DELETE FROM pending_swaps WHERE signature = ?`).run(signature);
}

export function listPending(): PendingSwap[] {
  return db
    .prepare(
      `SELECT signature, side, input_mint as inputMint, output_mint as outputMint,
              input_amount as inputAmount, quote_out_amount as quoteOutAmount,
              leader, sent_at as sentAt, blockhash,
              last_valid_block_height as lastValidBlockHeight
         FROM pending_swaps ORDER BY sent_at ASC`,
    )
    .all() as PendingSwap[];
}

/**
 * On startup, walk pending swaps and ask the RPC what actually happened.
 * Possible outcomes:
 *   - confirmed OK  → clear pending; caller reconciles the position on-chain
 *   - confirmed err → clear pending; nothing to do
 *   - not found + blockhash expired → clear pending, tx never landed
 *   - not found + blockhash live    → still pending, leave for next check
 */
export async function recoverPending(conn: Connection): Promise<{
  landed: number; failed: number; expired: number; stillPending: number;
}> {
  const pending = listPending();
  if (pending.length === 0) return { landed: 0, failed: 0, expired: 0, stillPending: 0 };
  log.warn({ count: pending.length }, "recovering pending swaps from previous run");

  let landed = 0, failed = 0, expired = 0, stillPending = 0;
  const currentHeight = await conn.getBlockHeight("confirmed").catch(() => 0);

  for (const p of pending) {
    try {
      const status = await conn.getSignatureStatus(p.signature, {
        searchTransactionHistory: true,
      });
      const v = status?.value;
      if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") {
        if (v.err) {
          log.info({ sig: p.signature }, "pending: confirmed with error");
          failed++;
        } else {
          log.info({ sig: p.signature }, "pending: landed cleanly (reconcile will fix position)");
          landed++;
        }
        clearPending(p.signature);
        incr("pending_recovered_total");
        continue;
      }
      if (p.lastValidBlockHeight && currentHeight > p.lastValidBlockHeight) {
        log.info({ sig: p.signature }, "pending: blockhash expired without landing");
        clearPending(p.signature);
        expired++;
        incr("pending_expired_total");
        continue;
      }
      stillPending++;
      log.info({ sig: p.signature }, "pending: still in flight; will re-check next startup");
    } catch (err) {
      log.warn({ err: (err as Error).message, sig: p.signature }, "pending: status check failed");
      stillPending++;
    }
  }
  return { landed, failed, expired, stillPending };
}
