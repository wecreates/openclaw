import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import "../src/state.js";
import { allocationCheck } from "../src/allocation.js";

const CONFIG = await import("../src/config.js");
const DB_PATH = process.env.DB_PATH!;

function reset(): void {
  const db = new Database(DB_PATH);
  db.exec(`DELETE FROM positions;`);
  db.close();
}

function seedPos(mint: string, leader: string, sol: number): void {
  const db = new Database(DB_PATH);
  db.prepare(
    `INSERT OR REPLACE INTO positions
      (mint, leader, amount_raw, sol_spent_lamports, opened_at, tx_sig,
       peak_price_sol_per_token, last_price_sol_per_token, entry_price_sol_per_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(mint, leader, "1", Math.floor(sol * 1e9), Date.now(), null, 0, 0, 0);
  db.close();
}

describe("allocation.allocationCheck", () => {
  beforeEach(() => reset());

  it("passes when portfolio is empty", () => {
    (CONFIG.config as any).maxPercentPerMint = 0.4;
    (CONFIG.config as any).maxPercentPerLeader = 0.5;
    const r = allocationCheck({ mint: "M", leader: "L", sizeLamports: 1e9 });
    expect(r.ok).toBe(true);
  });

  it("blocks a mint that would exceed the mint cap", () => {
    (CONFIG.config as any).maxPercentPerMint = 0.4;
    (CONFIG.config as any).maxPercentPerLeader = 1;
    seedPos("MintA", "L1", 0.3);
    seedPos("MintB", "L2", 0.1);
    // Adding 0.5 to MintA → 0.8/0.9 = 89% > 40%
    const r = allocationCheck({ mint: "MintA", leader: "L1", sizeLamports: Math.floor(0.5e9) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("mint");
  });

  it("blocks a leader that would exceed the leader cap", () => {
    (CONFIG.config as any).maxPercentPerMint = 1;
    (CONFIG.config as any).maxPercentPerLeader = 0.5;
    seedPos("MintA", "L1", 0.3);
    seedPos("MintB", "L2", 0.1);
    // Adding 0.3 to L1 → 0.6/0.7 = 86% > 50%
    const r = allocationCheck({ mint: "MintC", leader: "L1", sizeLamports: Math.floor(0.3e9) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("leader");
  });

  it("passes when both caps are 0 (disabled)", () => {
    (CONFIG.config as any).maxPercentPerMint = 0;
    (CONFIG.config as any).maxPercentPerLeader = 0;
    seedPos("MintA", "L1", 0.9);
    const r = allocationCheck({ mint: "MintA", leader: "L1", sizeLamports: 1e9 });
    expect(r.ok).toBe(true);
  });
});
