import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import "../src/state.js";
import { clearPending, listPending, recordPending, recoverPending } from "../src/pendingswap.js";

const DB_PATH = process.env.DB_PATH!;

function reset(): void {
  const db = new Database(DB_PATH);
  db.exec("DELETE FROM pending_swaps;");
  db.close();
}

describe("pending swap ledger", () => {
  beforeEach(() => reset());

  it("records and lists a pending swap", () => {
    recordPending({
      signature: "sigA", side: "buy",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "MintX", inputAmount: "1000", quoteOutAmount: "500",
      leader: "LeaderA", sentAt: Date.now(),
      blockhash: "hashA", lastValidBlockHeight: 100,
    });
    const pend = listPending();
    expect(pend).toHaveLength(1);
    expect(pend[0]!.signature).toBe("sigA");
    expect(pend[0]!.side).toBe("buy");
  });

  it("clearPending removes the row", () => {
    recordPending({
      signature: "sigB", side: "sell",
      inputMint: "MintX", outputMint: "So11111111111111111111111111111111111111112",
      inputAmount: "5", quoteOutAmount: "10",
      leader: null, sentAt: Date.now(),
      blockhash: "hashB", lastValidBlockHeight: 100,
    });
    clearPending("sigB");
    expect(listPending()).toHaveLength(0);
  });

  it("recovers by classifying: landed / failed / expired / still-pending", async () => {
    recordPending({
      signature: "sigLanded", side: "buy",
      inputMint: "SOL", outputMint: "MintX",
      inputAmount: "1", quoteOutAmount: "1",
      leader: "L", sentAt: Date.now(),
      blockhash: "h", lastValidBlockHeight: 200,
    });
    recordPending({
      signature: "sigFailed", side: "buy",
      inputMint: "SOL", outputMint: "MintX",
      inputAmount: "1", quoteOutAmount: "1",
      leader: "L", sentAt: Date.now(),
      blockhash: "h", lastValidBlockHeight: 200,
    });
    recordPending({
      signature: "sigExpired", side: "buy",
      inputMint: "SOL", outputMint: "MintX",
      inputAmount: "1", quoteOutAmount: "1",
      leader: "L", sentAt: Date.now(),
      blockhash: "h", lastValidBlockHeight: 50,
    });
    recordPending({
      signature: "sigStill", side: "buy",
      inputMint: "SOL", outputMint: "MintX",
      inputAmount: "1", quoteOutAmount: "1",
      leader: "L", sentAt: Date.now(),
      blockhash: "h", lastValidBlockHeight: 500,
    });
    const conn = {
      getBlockHeight: vi.fn().mockResolvedValue(300),
      getSignatureStatus: vi.fn().mockImplementation(async (sig: string) => {
        if (sig === "sigLanded") return { value: { confirmationStatus: "confirmed", err: null } };
        if (sig === "sigFailed") return { value: { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } } };
        return { value: null };
      }),
    } as any;
    const r = await recoverPending(conn);
    expect(r).toEqual({ landed: 1, failed: 1, expired: 1, stillPending: 1 });
    // Only "sigStill" remains
    const rest = listPending();
    expect(rest.map((p) => p.signature)).toEqual(["sigStill"]);
  });
});
