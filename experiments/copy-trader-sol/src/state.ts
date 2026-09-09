import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrate.js";

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
    peak_price_sol_per_token REAL DEFAULT 0,
    last_price_sol_per_token REAL DEFAULT 0,
    entry_price_sol_per_token REAL DEFAULT 0,
    PRIMARY KEY (mint, leader)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    side TEXT NOT NULL,
    mint TEXT NOT NULL,
    leader TEXT NOT NULL,
    sol_delta_lamports INTEGER NOT NULL,
    tx_sig TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seen_tx (
    signature TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
`);

runMigrations(db);

export type Position = {
  mint: string;
  leader: string;
  amountRaw: string;
  solSpentLamports: number;
  openedAt: number;
  txSig: string | null;
  peakPriceSolPerToken: number;
  lastPriceSolPerToken: number;
  entryPriceSolPerToken: number;
};

export function openPosition(p: Position): void {
  db.prepare(
    `INSERT OR REPLACE INTO positions
       (mint, leader, amount_raw, sol_spent_lamports, opened_at, tx_sig,
        peak_price_sol_per_token, last_price_sol_per_token, entry_price_sol_per_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.mint, p.leader, p.amountRaw, p.solSpentLamports, p.openedAt, p.txSig,
    p.entryPriceSolPerToken, p.entryPriceSolPerToken, p.entryPriceSolPerToken,
  );
}

export function getPosition(mint: string, leader: string): Position | null {
  const row = db
    .prepare(
      `SELECT mint, leader, amount_raw as amountRaw,
              sol_spent_lamports as solSpentLamports,
              opened_at as openedAt, tx_sig as txSig,
              peak_price_sol_per_token as peakPriceSolPerToken,
              last_price_sol_per_token as lastPriceSolPerToken,
              entry_price_sol_per_token as entryPriceSolPerToken
         FROM positions WHERE mint = ? AND leader = ?`,
    )
    .get(mint, leader);
  return (row as Position | undefined) ?? null;
}

export function listPositions(): Position[] {
  return db
    .prepare(
      `SELECT mint, leader, amount_raw as amountRaw,
              sol_spent_lamports as solSpentLamports,
              opened_at as openedAt, tx_sig as txSig,
              peak_price_sol_per_token as peakPriceSolPerToken,
              last_price_sol_per_token as lastPriceSolPerToken,
              entry_price_sol_per_token as entryPriceSolPerToken
         FROM positions ORDER BY opened_at DESC`,
    )
    .all() as Position[];
}

export function countPositions(): number {
  const row = db.prepare(`SELECT COUNT(*) as n FROM positions`).get() as { n: number };
  return row.n;
}

export function updatePositionPrice(
  mint: string,
  leader: string,
  currentPrice: number,
  peakPrice: number,
): void {
  db.prepare(
    `UPDATE positions
       SET last_price_sol_per_token = ?, peak_price_sol_per_token = ?
       WHERE mint = ? AND leader = ?`,
  ).run(currentPrice, peakPrice, mint, leader);
}

export function updatePositionAmount(
  mint: string,
  leader: string,
  newAmountRaw: string,
  solSpentLamports: number,
): void {
  db.prepare(
    `UPDATE positions
       SET amount_raw = ?, sol_spent_lamports = ?
       WHERE mint = ? AND leader = ?`,
  ).run(newAmountRaw, solSpentLamports, mint, leader);
}

export function closePosition(mint: string, leader: string): void {
  db.prepare(`DELETE FROM positions WHERE mint = ? AND leader = ?`).run(mint, leader);
}

export function recordTrade(t: {
  side: "buy" | "sell";
  mint: string;
  leader: string;
  solDeltaLamports: number;
  txSig: string | null;
  reason?: string;
}): void {
  db.prepare(
    `INSERT INTO trades (side, mint, leader, sol_delta_lamports, tx_sig, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.side, t.mint, t.leader, t.solDeltaLamports, t.txSig, t.reason ?? null, Date.now(),
  );
}

export type Trade = {
  id: number;
  side: "buy" | "sell";
  mint: string;
  leader: string;
  solDeltaLamports: number;
  txSig: string | null;
  reason: string | null;
  createdAt: number;
};

export function listRecentTrades(limit = 50): Trade[] {
  return db
    .prepare(
      `SELECT id, side, mint, leader,
              sol_delta_lamports as solDeltaLamports,
              tx_sig as txSig, reason, created_at as createdAt
         FROM trades ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Trade[];
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

export function totalPnlLamports(): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(sol_delta_lamports), 0) as pnl FROM trades`)
    .get() as { pnl: number };
  return row.pnl;
}

export function markSeen(sig: string): boolean {
  const res = db
    .prepare(`INSERT OR IGNORE INTO seen_tx (signature, at) VALUES (?, ?)`)
    .run(sig, Date.now());
  return res.changes > 0;
}
