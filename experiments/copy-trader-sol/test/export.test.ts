import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { exportTradesCsv } from "../src/export.js";
import "../src/state.js";

const DB_PATH = process.env.DB_PATH!;

function reset(): void {
  const db = new Database(DB_PATH);
  db.exec("DELETE FROM trades;");
  db.close();
}

function seed(side: "buy" | "sell", delta: number, reason = ""): void {
  const db = new Database(DB_PATH);
  db.prepare(
    `INSERT INTO trades (side, mint, leader, sol_delta_lamports, tx_sig, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(side, "MintX", "LeaderA", delta, "sigZZ", reason, Date.now());
  db.close();
}

describe("export.exportTradesCsv", () => {
  beforeEach(() => reset());

  it("writes header + rows and escapes commas in reason", () => {
    seed("buy", -50_000_000, "copy LeaderA · rpc");
    seed("sell", 80_000_000, 'contains,commas and "quotes"');
    const path = "./data/exp-test.csv";
    try { rmSync(path); } catch {/*ok*/}
    const n = exportTradesCsv(path);
    expect(n).toBe(2);
    const csv = readFileSync(path, "utf8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("side,mint,leader,sol_delta");
    expect(lines).toHaveLength(3);
    expect(csv).toContain('"contains,commas and ""quotes"""');
  });
});
