import type { Database as DB } from "better-sqlite3";
import { log } from "./log.js";

type Migration = { version: number; name: string; sql: string };

/**
 * Additive migrations only. Each runs once, in order. Never edit a landed
 * migration — add a new one. `IF NOT EXISTS` on tables/columns means running
 * the base schema before migrations is safe on both fresh and legacy DBs.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "pending_swaps + sell_queue + balance_alerts",
    sql: `
      CREATE TABLE IF NOT EXISTS pending_swaps (
        signature TEXT PRIMARY KEY,
        side TEXT NOT NULL,
        input_mint TEXT NOT NULL,
        output_mint TEXT NOT NULL,
        input_amount TEXT NOT NULL,
        quote_out_amount TEXT NOT NULL,
        leader TEXT,
        sent_at INTEGER NOT NULL,
        blockhash TEXT NOT NULL,
        last_valid_block_height INTEGER
      );
      CREATE TABLE IF NOT EXISTS sell_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        leader TEXT NOT NULL,
        amount_raw TEXT NOT NULL,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_try_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sell_queue_next_try ON sell_queue (next_try_at);
      CREATE TABLE IF NOT EXISTS balance_alerts (
        alert_at INTEGER NOT NULL,
        below_lamports INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "positions.actual_fill_price + trades.slippage_bps",
    sql: `
      ALTER TABLE positions ADD COLUMN actual_fill_price_sol_per_token REAL DEFAULT 0;
      ALTER TABLE trades    ADD COLUMN realized_slippage_bps INTEGER DEFAULT 0;
    `,
  },
];

export function runMigrations(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      name TEXT NOT NULL
    );
  `);
  const currentRow = db
    .prepare(`SELECT COALESCE(MAX(version), 0) as v FROM schema_version`)
    .get() as { v: number };
  const current = currentRow.v;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    log.info({ version: m.version, migration: m.name }, "applying migration");
    const tx = db.transaction(() => {
      // Some ALTER statements throw "duplicate column" on partially-migrated
      // DBs; swallow that but propagate everything else so bad SQL surfaces.
      const stmts = m.sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const s of stmts) {
        try {
          db.exec(s);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes("duplicate column")) continue;
          throw err;
        }
      }
      db.prepare(
        `INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)`,
      ).run(m.version, Date.now(), m.name);
    });
    tx();
  }
}
