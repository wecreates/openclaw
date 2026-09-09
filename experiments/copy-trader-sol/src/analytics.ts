import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH ?? "./data/state.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

export type PerKey = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  netLamports: number;
  winRate: number;
};

function agg(sql: string, ...params: any[]): PerKey[] {
  const rows = db.prepare(sql).all(...params) as {
    key: string; trades: number; wins: number; losses: number; netLamports: number;
  }[];
  return rows.map((r) => ({
    ...r,
    winRate: r.trades > 0 ? r.wins / r.trades : 0,
  }));
}

/** Per-mint stats over closed sells. Sorted by net desc. */
export function perMint(limit = 50): PerKey[] {
  return agg(
    `SELECT mint as key,
            COUNT(*) as trades,
            SUM(CASE WHEN sol_delta_lamports > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN sol_delta_lamports < 0 THEN 1 ELSE 0 END) as losses,
            COALESCE(SUM(sol_delta_lamports), 0) as netLamports
       FROM trades WHERE side='sell'
       GROUP BY mint ORDER BY netLamports DESC LIMIT ?`,
    limit,
  );
}

/** Per-leader stats over closed sells. Sorted by net desc. */
export function perLeader(limit = 50): PerKey[] {
  return agg(
    `SELECT leader as key,
            COUNT(*) as trades,
            SUM(CASE WHEN sol_delta_lamports > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN sol_delta_lamports < 0 THEN 1 ELSE 0 END) as losses,
            COALESCE(SUM(sol_delta_lamports), 0) as netLamports
       FROM trades WHERE side='sell'
       GROUP BY leader ORDER BY netLamports DESC LIMIT ?`,
    limit,
  );
}

/**
 * Hour-of-day stats: bucket every closed sell into hour 0-23 of local time
 * and aggregate. Useful for spotting session windows (US, Asia, EU) where
 * copy-trading works better or worse.
 */
export function perHourOfDay(): PerKey[] {
  const rows = db
    .prepare(
      `SELECT sol_delta_lamports as delta, created_at as ts
         FROM trades WHERE side='sell'`,
    )
    .all() as { delta: number; ts: number }[];
  const buckets = new Map<number, { trades: number; wins: number; losses: number; net: number }>();
  for (const r of rows) {
    const h = new Date(r.ts).getUTCHours();
    const b = buckets.get(h) ?? { trades: 0, wins: 0, losses: 0, net: 0 };
    b.trades++;
    if (r.delta > 0) b.wins++;
    if (r.delta < 0) b.losses++;
    b.net += r.delta;
    buckets.set(h, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([h, b]) => ({
      key: `${String(h).padStart(2, "0")}:00 UTC`,
      trades: b.trades,
      wins: b.wins,
      losses: b.losses,
      netLamports: b.net,
      winRate: b.trades > 0 ? b.wins / b.trades : 0,
    }));
}
