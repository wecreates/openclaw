import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/state.db";
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS mutes (
    leader TEXT PRIMARY KEY,
    muted_at INTEGER NOT NULL,
    reason TEXT
  );
`);

export type LeaderStats = {
  leader: string;
  trades: number;
  wins: number;
  losses: number;
  netLamports: number;
  winRate: number;
};

export function leaderStats(leader?: string): LeaderStats[] {
  const rows = db
    .prepare(
      `SELECT leader,
              COUNT(*) as trades,
              SUM(CASE WHEN sol_delta_lamports > 0 THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN sol_delta_lamports < 0 AND side='sell' THEN 1 ELSE 0 END) as losses,
              COALESCE(SUM(sol_delta_lamports), 0) as netLamports
         FROM trades
         WHERE side='sell'${leader ? " AND leader=?" : ""}
         GROUP BY leader
         ORDER BY netLamports DESC`,
    )
    .all(...(leader ? [leader] : [])) as {
    leader: string;
    trades: number;
    wins: number;
    losses: number;
    netLamports: number;
  }[];
  return rows.map((r) => ({
    ...r,
    winRate: r.trades > 0 ? r.wins / r.trades : 0,
  }));
}

export function muteLeader(leader: string, reason: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO mutes (leader, muted_at, reason) VALUES (?, ?, ?)`,
  ).run(leader, Date.now(), reason);
}

export function unmuteLeader(leader: string): void {
  db.prepare(`DELETE FROM mutes WHERE leader = ?`).run(leader);
}

export function isMuted(leader: string): boolean {
  const row = db.prepare(`SELECT 1 FROM mutes WHERE leader = ?`).get(leader);
  return row !== undefined;
}

export function listMutes(): { leader: string; mutedAt: number; reason: string | null }[] {
  return db
    .prepare(`SELECT leader, muted_at as mutedAt, reason FROM mutes ORDER BY muted_at DESC`)
    .all() as { leader: string; mutedAt: number; reason: string | null }[];
}

/**
 * After every closed trade, check if this leader's stats now warrant an
 * auto-mute. Cheap enough to call inline. Thresholds:
 *   - ≥minTrades closed sells, AND
 *   - net PnL is negative, AND
 *   - win-rate below `winRateFloor` OR consecutive-loss streak ≥ `maxLossStreak`.
 */
export function evaluateAutoMute(
  leader: string,
  cfg: {
    minTrades: number;
    winRateFloor: number;
    maxLossStreak: number;
  },
): { muted: boolean; reason?: string } {
  const [stats] = leaderStats(leader);
  if (!stats || stats.trades < cfg.minTrades) return { muted: false };
  if (stats.netLamports >= 0) return { muted: false };

  if (stats.winRate < cfg.winRateFloor) {
    const reason = `winrate ${(stats.winRate * 100).toFixed(0)}% < ${(cfg.winRateFloor * 100).toFixed(0)}% over ${stats.trades} trades`;
    muteLeader(leader, reason);
    return { muted: true, reason };
  }

  const recent = db
    .prepare(
      `SELECT sol_delta_lamports as d FROM trades
         WHERE side='sell' AND leader=? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(leader, cfg.maxLossStreak) as { d: number }[];
  if (
    recent.length === cfg.maxLossStreak &&
    recent.every((r) => r.d < 0)
  ) {
    const reason = `${cfg.maxLossStreak} consecutive losing sells`;
    muteLeader(leader, reason);
    return { muted: true, reason };
  }
  return { muted: false };
}
