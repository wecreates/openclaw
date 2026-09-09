import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  evaluateAutoMute,
  isMuted,
  muteLeader,
  unmuteLeader,
} from "../src/scoring.js";
import "../src/state.js";

const DB_PATH = process.env.DB_PATH!;

function reset(): void {
  const db = new Database(DB_PATH);
  db.exec(`DELETE FROM trades; DELETE FROM mutes;`);
  db.close();
}

function seedSell(delta: number, leader = "LeaderA", ageMs = 0): void {
  const db = new Database(DB_PATH);
  db.prepare(
    `INSERT INTO trades (side, mint, leader, sol_delta_lamports, tx_sig, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("sell", "MintX", leader, delta, null, null, Date.now() - ageMs);
  db.close();
}

describe("scoring.evaluateAutoMute", () => {
  beforeEach(() => reset());

  it("does not mute below minTrades", () => {
    seedSell(-100);
    seedSell(-100);
    const r = evaluateAutoMute("LeaderA", { minTrades: 5, winRateFloor: 0.5, maxLossStreak: 4 });
    expect(r.muted).toBe(false);
  });

  it("does not mute when net PnL is positive", () => {
    for (let i = 0; i < 5; i++) seedSell(-100);
    seedSell(1_000_000);
    const r = evaluateAutoMute("LeaderA", { minTrades: 5, winRateFloor: 0.9, maxLossStreak: 4 });
    expect(r.muted).toBe(false);
  });

  it("mutes on winrate floor breach", () => {
    for (let i = 0; i < 6; i++) seedSell(-100);
    const r = evaluateAutoMute("LeaderA", { minTrades: 5, winRateFloor: 0.3, maxLossStreak: 10 });
    expect(r.muted).toBe(true);
    expect(isMuted("LeaderA")).toBe(true);
  });

  it("mutes on loss streak of 4 with negative net", () => {
    seedSell(500, "LeaderB", 100_000);
    for (let i = 0; i < 4; i++) seedSell(-1000, "LeaderB", (4 - i) * 1000);
    const r = evaluateAutoMute("LeaderB", { minTrades: 3, winRateFloor: 0, maxLossStreak: 4 });
    expect(r.muted).toBe(true);
  });

  it("does NOT mute when streak includes a winner", () => {
    seedSell(-100, "LeaderC", 40_000);
    seedSell(-100, "LeaderC", 30_000);
    seedSell(1000, "LeaderC", 20_000);
    seedSell(-100, "LeaderC", 10_000);
    // net still negative but the streak of 4 back is not all losses
    const r = evaluateAutoMute("LeaderC", { minTrades: 3, winRateFloor: 0, maxLossStreak: 4 });
    expect(r.muted).toBe(false);
  });

  it("manual mute + unmute cycle", () => {
    muteLeader("LeaderD", "test");
    expect(isMuted("LeaderD")).toBe(true);
    unmuteLeader("LeaderD");
    expect(isMuted("LeaderD")).toBe(false);
  });
});
