import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { log } from "./log.js";
import { fmtSol, notify } from "./notify.js";
import { incr } from "./metrics.js";

const DB_PATH = process.env.DB_PATH ?? "./data/state.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/**
 * Poll the trading wallet's SOL balance every N minutes. When it drops
 * below WALLET_BALANCE_ALERT_SOL, notify once per config.balanceAlertCooldownH
 * hours so a stuck-low wallet doesn't spam alerts.
 */
export function startBalanceMonitor(
  conn: Connection,
  walletPubkey: PublicKey,
): () => void {
  let stopped = false;
  const check = async (): Promise<void> => {
    if (stopped) return;
    try {
      const lamports = await conn.getBalance(walletPubkey, "confirmed");
      const thresh = Math.floor(config.walletBalanceAlertSol * LAMPORTS_PER_SOL);
      if (lamports >= thresh) return;
      const last = db
        .prepare(`SELECT MAX(alert_at) as t FROM balance_alerts WHERE below_lamports >= ?`)
        .get(thresh) as { t: number | null };
      const cooldownMs = config.balanceAlertCooldownHours * 3_600_000;
      if (last.t && Date.now() - last.t < cooldownMs) return;
      db.prepare(
        `INSERT INTO balance_alerts (alert_at, below_lamports) VALUES (?, ?)`,
      ).run(Date.now(), thresh);
      log.warn({ balance: fmtSol(lamports), threshold: fmtSol(thresh) }, "wallet low");
      notify(
        `💸 wallet low: ${fmtSol(lamports)} SOL (below ${fmtSol(thresh)} SOL alert threshold). Top up ${walletPubkey.toBase58()}`,
      );
      incr("balance_alerts_total");
    } catch (err) {
      log.debug({ err: (err as Error).message }, "balance check failed");
    }
  };

  void check();
  const iv = setInterval(() => void check(), config.balanceCheckIntervalMinutes * 60_000);
  return () => { stopped = true; clearInterval(iv); };
}
