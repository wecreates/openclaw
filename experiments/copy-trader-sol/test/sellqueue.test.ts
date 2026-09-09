import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import "../src/state.js";
import { enqueueSell, queueDepth } from "../src/sellqueue.js";

const DB_PATH = process.env.DB_PATH!;

function reset(): void {
  const db = new Database(DB_PATH);
  db.exec("DELETE FROM sell_queue;");
  db.close();
}

describe("sellqueue", () => {
  beforeEach(() => reset());

  it("enqueues and reports depth", () => {
    enqueueSell({
      mint: "MintX", leader: "LeaderA",
      amountRaw: 1_000_000_000n, reason: "stop-loss",
    });
    enqueueSell({
      mint: "MintY", leader: "LeaderB",
      amountRaw: 5_000_000n, reason: "trailing-tp",
    });
    expect(queueDepth()).toBe(2);
  });

  it("first-due row is picked up before later ones", () => {
    enqueueSell({
      mint: "MintZ", leader: "LeaderC",
      amountRaw: 1n, reason: "z",
    });
    const db = new Database(DB_PATH);
    const rows = db
      .prepare(`SELECT mint, next_try_at FROM sell_queue ORDER BY next_try_at ASC`)
      .all() as { mint: string; next_try_at: number }[];
    db.close();
    expect(rows[0]!.mint).toBe("MintZ");
    expect(rows[0]!.next_try_at).toBeLessThanOrEqual(Date.now() + 100);
  });
});
