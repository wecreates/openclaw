import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/migrate.js";

const DB_PATH = process.env.DB_PATH!;

beforeEach(() => {
  const db = new Database(DB_PATH);
  db.exec(`
    DROP TABLE IF EXISTS schema_version;
    DROP TABLE IF EXISTS pending_swaps;
    DROP TABLE IF EXISTS sell_queue;
    DROP TABLE IF EXISTS balance_alerts;
  `);
  db.close();
});

describe("migrate.runMigrations", () => {
  it("creates schema_version and applies all migrations", () => {
    const db = new Database(DB_PATH);
    // Assume base schema is present (state.ts creates it) — this test only
    // asserts migrations don't fail and record their version.
    db.exec(`
      CREATE TABLE IF NOT EXISTS positions (mint TEXT, leader TEXT, amount_raw TEXT,
        sol_spent_lamports INTEGER, opened_at INTEGER, tx_sig TEXT,
        peak_price_sol_per_token REAL, last_price_sol_per_token REAL,
        entry_price_sol_per_token REAL, PRIMARY KEY (mint, leader));
      CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY, side TEXT, mint TEXT,
        leader TEXT, sol_delta_lamports INTEGER, tx_sig TEXT, reason TEXT, created_at INTEGER);
    `);
    runMigrations(db);
    const versions = db
      .prepare(`SELECT version FROM schema_version ORDER BY version`)
      .all() as { version: number }[];
    expect(versions.map((r) => r.version)).toEqual([1, 2]);
    // pending_swaps exists
    const cols = db
      .prepare(`PRAGMA table_info(pending_swaps)`)
      .all() as { name: string }[];
    expect(cols.some((c) => c.name === "signature")).toBe(true);
    db.close();
  });

  it("is idempotent — running twice does nothing new", () => {
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS positions (mint TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY);
    `);
    runMigrations(db);
    const firstCount = (db.prepare(`SELECT COUNT(*) as n FROM schema_version`).get() as any).n;
    runMigrations(db);
    const secondCount = (db.prepare(`SELECT COUNT(*) as n FROM schema_version`).get() as any).n;
    expect(secondCount).toBe(firstCount);
    db.close();
  });
});
