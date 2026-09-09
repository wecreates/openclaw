import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import "../src/state.js";
import { perHourOfDay, perLeader, perMint } from "../src/analytics.js";

const DB_PATH = process.env.DB_PATH!;

function reset(): void {
  const db = new Database(DB_PATH);
  db.exec("DELETE FROM trades;");
  db.close();
}

function seedSell(mint: string, leader: string, delta: number, at: number): void {
  const db = new Database(DB_PATH);
  db.prepare(
    `INSERT INTO trades (side, mint, leader, sol_delta_lamports, tx_sig, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("sell", mint, leader, delta, null, null, at);
  db.close();
}

describe("analytics", () => {
  beforeEach(() => reset());

  it("perMint sums per mint and orders by net desc", () => {
    seedSell("MintA", "L1", 100, Date.now());
    seedSell("MintA", "L2", -50, Date.now());
    seedSell("MintB", "L1", -200, Date.now());
    seedSell("MintC", "L1", 500, Date.now());
    const r = perMint();
    expect(r[0]!.key).toBe("MintC");
    expect(r[0]!.netLamports).toBe(500);
    expect(r.find((x) => x.key === "MintA")!.netLamports).toBe(50);
    expect(r.find((x) => x.key === "MintB")!.netLamports).toBe(-200);
  });

  it("perLeader wins + losses + winrate", () => {
    seedSell("MintA", "LeaderX", 100, Date.now());
    seedSell("MintB", "LeaderX", 200, Date.now());
    seedSell("MintC", "LeaderX", -50, Date.now());
    const r = perLeader();
    const x = r.find((x) => x.key === "LeaderX")!;
    expect(x.wins).toBe(2);
    expect(x.losses).toBe(1);
    expect(x.winRate).toBeCloseTo(2 / 3, 3);
  });

  it("perHourOfDay buckets by UTC hour", () => {
    const ts9 = Date.UTC(2026, 5, 1, 9, 30, 0);
    const ts15 = Date.UTC(2026, 5, 1, 15, 30, 0);
    seedSell("M", "L", 100, ts9);
    seedSell("M", "L", -20, ts9);
    seedSell("M", "L", 50, ts15);
    const r = perHourOfDay();
    const h9 = r.find((x) => x.key.startsWith("09"))!;
    const h15 = r.find((x) => x.key.startsWith("15"))!;
    expect(h9.trades).toBe(2);
    expect(h9.netLamports).toBe(80);
    expect(h15.trades).toBe(1);
  });
});
