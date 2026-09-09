import Database from "better-sqlite3";
import { Connection, Keypair } from "@solana/web3.js";
import { buy as execBuy } from "./executor.js";
import { openPosition, recordTrade } from "./state.js";
import { log } from "./log.js";
import { fmtSol, notify } from "./notify.js";
import { incr } from "./metrics.js";
import { markLeaderBought } from "./cooldown.js";
import { config } from "./config.js";

const DB_PATH = process.env.DB_PATH ?? "./data/state.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/**
 * Buys age out fast — a leader's signal is stale after 60s. We keep the
 * buy queue tighter than the sell queue and drop entries whose age exceeds
 * BUY_QUEUE_TTL_SEC by the time we get to them.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS buy_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    leader TEXT NOT NULL,
    size_lamports INTEGER NOT NULL,
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER NOT NULL,
    signal_ts INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS buy_queue_next_try ON buy_queue (next_try_at);
`);

const BACKOFFS_MS = [5_000, 15_000, 30_000];

export function enqueueBuy(args: {
  mint: string; leader: string; sizeLamports: number; signalTs: number; reason: string;
}): void {
  db.prepare(
    `INSERT INTO buy_queue (mint, leader, size_lamports, reason, attempts, next_try_at, signal_ts, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(args.mint, args.leader, args.sizeLamports, args.reason, Date.now(), args.signalTs, Date.now());
  incr("buy_queue_enqueued_total");
}

type Row = {
  id: number; mint: string; leader: string;
  sizeLamports: number; reason: string; attempts: number;
  nextTryAt: number; signalTs: number;
};

function due(): Row[] {
  return db
    .prepare(
      `SELECT id, mint, leader,
              size_lamports as sizeLamports, reason, attempts,
              next_try_at as nextTryAt, signal_ts as signalTs
         FROM buy_queue WHERE next_try_at <= ?
         ORDER BY next_try_at ASC LIMIT 5`,
    )
    .all(Date.now()) as Row[];
}

function drop(id: number): void {
  db.prepare(`DELETE FROM buy_queue WHERE id = ?`).run(id);
}
function reschedule(id: number, attempts: number): void {
  const delay = BACKOFFS_MS[Math.min(attempts, BACKOFFS_MS.length - 1)]!;
  db.prepare(`UPDATE buy_queue SET attempts = ?, next_try_at = ? WHERE id = ?`)
    .run(attempts, Date.now() + delay, id);
}

async function processOne(conn: Connection, kp: Keypair, r: Row): Promise<void> {
  const ageSec = (Date.now() - r.signalTs) / 1000;
  if (ageSec > config.buyQueueTtlSec) {
    log.info({ id: r.id, mint: r.mint, ageSec }, "buy queue: signal stale, dropping");
    drop(r.id);
    incr("buy_queue_stale_total");
    return;
  }
  try {
    const res = await execBuy(conn, kp, r.mint, r.sizeLamports);
    openPosition({
      mint: r.mint, leader: r.leader,
      amountRaw: res.tokenAmountRaw.toString(),
      solSpentLamports: res.solLamports,
      openedAt: Date.now(), txSig: res.signature,
      entryPriceSolPerToken: res.actualFillPrice,
      peakPriceSolPerToken: res.actualFillPrice,
      lastPriceSolPerToken: res.actualFillPrice,
    });
    recordTrade({
      side: "buy", mint: r.mint, leader: r.leader,
      solDeltaLamports: -res.solLamports, txSig: res.signature,
      reason: `queued retry · ${r.reason} · ${res.route}`,
    });
    markLeaderBought(r.leader);
    drop(r.id);
    incr("buy_queue_success_total");
    notify(
      `🔁 queued buy landed *${r.mint.slice(0, 6)}…* (attempt ${r.attempts + 1})\nspent ${fmtSol(res.solLamports)} SOL`,
    );
  } catch (err) {
    incr("buy_queue_retry_total");
    if (r.attempts + 1 >= BACKOFFS_MS.length) {
      log.warn(
        { id: r.id, mint: r.mint, err: (err as Error).message, attempts: r.attempts + 1 },
        "buy queue: exhausted retries — dropping",
      );
      drop(r.id);
      return;
    }
    reschedule(r.id, r.attempts + 1);
  }
}

export function startBuyQueue(conn: Connection, kp: Keypair): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    for (const r of due()) {
      if (stopped) return;
      await processOne(conn, kp, r);
    }
  };
  const iv = setInterval(() => void tick(), 5_000);
  return () => { stopped = true; clearInterval(iv); };
}

export function buyQueueDepth(): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM buy_queue`).get() as { n: number }).n;
}
