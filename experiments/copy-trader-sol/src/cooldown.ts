import Database from "better-sqlite3";
import { config } from "./config.js";

const DB_PATH = process.env.DB_PATH ?? "./data/state.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS cooldowns (
    kind TEXT NOT NULL,
    key  TEXT NOT NULL,
    until INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );
`);

type Kind = "mint" | "leader";

function set(kind: Kind, key: string, ttlMs: number): void {
  const until = Date.now() + ttlMs;
  db.prepare(
    `INSERT OR REPLACE INTO cooldowns (kind, key, until) VALUES (?, ?, ?)`,
  ).run(kind, key, until);
}

function active(kind: Kind, key: string): boolean {
  const row = db
    .prepare(`SELECT until FROM cooldowns WHERE kind = ? AND key = ?`)
    .get(kind, key) as { until: number } | undefined;
  return !!row && row.until > Date.now();
}

export function markMintSold(mint: string): void {
  if (config.mintReentryCooldownMinutes > 0) {
    set("mint", mint, config.mintReentryCooldownMinutes * 60_000);
  }
}

export function markLeaderBought(leader: string): void {
  if (config.leaderRebuyCooldownMinutes > 0) {
    set("leader", leader, config.leaderRebuyCooldownMinutes * 60_000);
  }
}

export function mintOnCooldown(mint: string): boolean {
  return active("mint", mint);
}
export function leaderOnCooldown(leader: string): boolean {
  return active("leader", leader);
}

/** Test-only utility. */
export function _clearCooldowns(): void {
  db.exec(`DELETE FROM cooldowns`);
}
