import Database from "better-sqlite3";
import { Connection, Keypair } from "@solana/web3.js";
import { sell as execSell } from "./executor.js";
import { closePosition, getPosition, recordTrade, updatePositionAmount } from "./state.js";
import { log } from "./log.js";
import { fmtSol, notify } from "./notify.js";
import { incr } from "./metrics.js";

const DB_PATH = process.env.DB_PATH ?? "./data/state.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const BACKOFFS_MS = [30_000, 90_000, 300_000, 900_000, 3_600_000];

export function enqueueSell(args: {
  mint: string; leader: string; amountRaw: bigint; reason: string;
}): void {
  db.prepare(
    `INSERT INTO sell_queue (mint, leader, amount_raw, reason, attempts, next_try_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(args.mint, args.leader, args.amountRaw.toString(), args.reason, Date.now(), Date.now());
  incr("sell_queue_enqueued_total");
  log.warn({ mint: args.mint, leader: args.leader, reason: args.reason }, "sell queued for retry");
}

type Row = {
  id: number; mint: string; leader: string; amountRaw: string;
  reason: string; attempts: number; nextTryAt: number;
};

function due(): Row[] {
  return db
    .prepare(
      `SELECT id, mint, leader, amount_raw as amountRaw, reason,
              attempts, next_try_at as nextTryAt
         FROM sell_queue WHERE next_try_at <= ?
         ORDER BY next_try_at ASC LIMIT 10`,
    )
    .all(Date.now()) as Row[];
}

function reschedule(id: number, attempts: number): void {
  const delay = BACKOFFS_MS[Math.min(attempts, BACKOFFS_MS.length - 1)]!;
  db.prepare(
    `UPDATE sell_queue SET attempts = ?, next_try_at = ? WHERE id = ?`,
  ).run(attempts, Date.now() + delay, id);
}

function drop(id: number): void {
  db.prepare(`DELETE FROM sell_queue WHERE id = ?`).run(id);
}

async function processOne(conn: Connection, kp: Keypair, r: Row): Promise<void> {
  const pos = getPosition(r.mint, r.leader);
  if (!pos) {
    log.info({ id: r.id, mint: r.mint }, "sell queue: position gone, dropping");
    drop(r.id);
    return;
  }
  const heldNow = BigInt(pos.amountRaw);
  const wanted = BigInt(r.amountRaw);
  const amount = wanted > heldNow ? heldNow : wanted;
  if (amount <= 0n) { drop(r.id); return; }

  try {
    const res = await execSell(conn, kp, r.mint, amount);
    const proportionalCost = Math.floor(
      pos.solSpentLamports * (Number(amount) / Number(heldNow)),
    );
    if (amount >= heldNow) {
      closePosition(r.mint, r.leader);
    } else {
      updatePositionAmount(
        r.mint, r.leader,
        (heldNow - amount).toString(),
        pos.solSpentLamports - proportionalCost,
      );
    }
    const realized = res.solLamports - proportionalCost;
    recordTrade({
      side: "sell", mint: r.mint, leader: r.leader,
      solDeltaLamports: realized, txSig: res.signature,
      reason: `queued retry · ${r.reason} · ${res.route}`,
    });
    drop(r.id);
    incr("sell_queue_success_total");
    notify(
      `🔁 queued sell landed *${r.mint.slice(0, 6)}…* (attempt ${r.attempts + 1})\nrealized ${fmtSol(realized)} SOL`,
    );
  } catch (err) {
    incr("sell_queue_retry_total");
    if (r.attempts + 1 >= BACKOFFS_MS.length) {
      log.error(
        { id: r.id, mint: r.mint, err: (err as Error).message, attempts: r.attempts + 1 },
        "sell queue: exhausted retries — leaving in queue for manual review",
      );
      notify(
        `⚠️ sell queue *${r.mint.slice(0, 6)}…* exhausted after ${r.attempts + 1} tries. Check manually.`,
      );
      // keep it in the queue but reschedule far out so it doesn't spam
      reschedule(r.id, r.attempts + 1);
      return;
    }
    log.warn(
      { id: r.id, mint: r.mint, err: (err as Error).message, next: r.attempts + 1 },
      "sell queue: retry failed, rescheduling",
    );
    reschedule(r.id, r.attempts + 1);
  }
}

export function startSellQueue(conn: Connection, kp: Keypair): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const items = due();
    for (const r of items) {
      if (stopped) return;
      await processOne(conn, kp, r);
    }
  };
  const iv = setInterval(() => void tick(), 15_000);
  return () => { stopped = true; clearInterval(iv); };
}

export function queueDepth(): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM sell_queue`).get() as { n: number }).n;
}
