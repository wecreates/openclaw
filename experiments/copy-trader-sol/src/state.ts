import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/state.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    mint TEXT NOT NULL,
    leader TEXT NOT NULL,
    amount_raw TEXT NOT NULL,
    sol_spent_lamports INTEGER NOT NULL,
    opened_at INTEGER NOT NULL,
    tx_sig TEXT,
    PRIMARY KEY (mint, leader)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    side TEXT NOT NULL,
    mint TEXT NOT NULL,
    leader TEXT NOT NULL,
    sol_delta_lamports INTEGER NOT NULL,
    tx_sig TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seen_tx (
    signature TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
`);

export type Position = {
  mint: string;
  leader: string;
  amountRaw: string;
  solSpentLamports: number;
  openedAt: number;
  txSig: string | null;
};

export function openPosition(p: Position): void {
  db.prepare(
    `INSERT OR REPLACE INTO positions
       (mint, leader, amount_raw, sol_spent_lamports, opened_at, tx_sig)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(p.mint, p.leader, p.amountRaw, p.solSpentLamports, p.openedAt, p.txSig);
}

export function getPosition(mint: string, leader: string): Position | null {
  const row = db
    .prepare(
      `SELECT mint, leader, amount_raw as amountRaw,
              sol_spent_lamports as solSpentLamports,
              opened_at as openedAt, tx_sig as txSig
         FROM positions WHERE mint = ? AND leader = ?`,
    )
    .get(mint, leader);
  return (row as Position | undefined) ?? null;
}

export function closePosition(mint: string, leader: string): void {
  db.prepare(`DELETE FROM positions WHERE mint = ? AND leader = ?`).run(
    mint,
    leader,
  );
}

export function recordTrade(t: {
  side: "buy" | "sell";
  mint: string;
  leader: string;
  solDeltaLamports: number;
  txSig: string | null;
}): void {
  db.prepare(
    `INSERT INTO trades (side, mint, leader, sol_delta_lamports, tx_sig, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(t.side, t.mint, t.leader, t.solDeltaLamports, t.txSig, Date.now());
}

export function pnlLast24hLamports(): number {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(sol_delta_lamports), 0) as pnl
         FROM trades WHERE created_at >= ?`,
    )
    .get(since) as { pnl: number };
  return row.pnl;
}

export function markSeen(sig: string): boolean {
  const res = db
    .prepare(`INSERT OR IGNORE INTO seen_tx (signature, at) VALUES (?, ?)`)
    .run(sig, Date.now());
  return res.changes > 0;
}
