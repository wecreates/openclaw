import { describe, expect, it } from "vitest";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { detectSwapForWallet } from "../src/parser.js";

const LEADER = "LeaderWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function tx(args: {
  preSol: number;
  postSol: number;
  fee?: number;
  preTokenAmount?: string;
  postTokenAmount?: string;
  ownerKey?: string;
}) {
  const pre = args.preTokenAmount
    ? [
        {
          accountIndex: 0,
          mint: TOKEN,
          owner: args.ownerKey ?? LEADER,
          programId: TOKEN_PROGRAM,
          uiTokenAmount: {
            amount: args.preTokenAmount,
            decimals: 6,
            uiAmount: Number(args.preTokenAmount) / 1e6,
            uiAmountString: (Number(args.preTokenAmount) / 1e6).toString(),
          },
        },
      ]
    : [];
  const post = args.postTokenAmount
    ? [
        {
          accountIndex: 0,
          mint: TOKEN,
          owner: args.ownerKey ?? LEADER,
          programId: TOKEN_PROGRAM,
          uiTokenAmount: {
            amount: args.postTokenAmount,
            decimals: 6,
            uiAmount: Number(args.postTokenAmount) / 1e6,
            uiAmountString: (Number(args.postTokenAmount) / 1e6).toString(),
          },
        },
      ]
    : [];
  return {
    slot: 1,
    transaction: {
      signatures: ["sig"],
      message: { accountKeys: [{ pubkey: { toBase58: () => args.ownerKey ?? LEADER } }] },
    },
    meta: {
      err: null,
      fee: args.fee ?? 5000,
      preBalances: [args.preSol],
      postBalances: [args.postSol],
      preTokenBalances: pre,
      postTokenBalances: post,
    },
  } as any;
}

describe("parser.detectSwapForWallet", () => {
  it("detects a buy by SOL-out + token-in", () => {
    const s = detectSwapForWallet(
      tx({
        preSol: 2 * LAMPORTS_PER_SOL,
        postSol: LAMPORTS_PER_SOL - 5000,
        postTokenAmount: "1000000000",
      }),
      LEADER,
    );
    expect(s?.side).toBe("buy");
    expect(s?.solLamports).toBe(LAMPORTS_PER_SOL);
    expect(s?.tokenAmountRaw).toBe(1_000_000_000n);
    expect(s?.leaderPreTokenAmount).toBe(0n);
  });

  it("detects a full sell", () => {
    const s = detectSwapForWallet(
      tx({
        preSol: LAMPORTS_PER_SOL,
        postSol: LAMPORTS_PER_SOL + 0.6 * LAMPORTS_PER_SOL - 5000,
        preTokenAmount: "1000000000",
      }),
      LEADER,
    );
    expect(s?.side).toBe("sell");
    expect(s?.tokenAmountRaw).toBe(1_000_000_000n);
    expect(s?.leaderPostTokenAmount).toBe(0n);
  });

  it("computes partial-sell fraction correctly", () => {
    const s = detectSwapForWallet(
      tx({
        preSol: LAMPORTS_PER_SOL,
        postSol: LAMPORTS_PER_SOL + 0.3 * LAMPORTS_PER_SOL - 5000,
        preTokenAmount: "1000000000",
        postTokenAmount: "600000000",
      }),
      LEADER,
    );
    expect(s?.side).toBe("sell");
    const frac =
      Number((s!.tokenAmountRaw * 10000n) / s!.leaderPreTokenAmount) / 10000;
    expect(frac).toBeCloseTo(0.4, 5);
  });

  it("returns null for a different wallet", () => {
    const s = detectSwapForWallet(
      tx({ preSol: 100, postSol: 95, ownerKey: "SomeoneElseXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }),
      LEADER,
    );
    expect(s).toBeNull();
  });

  it("returns null on failed tx", () => {
    const failed = tx({
      preSol: 2 * LAMPORTS_PER_SOL,
      postSol: LAMPORTS_PER_SOL,
      postTokenAmount: "1000000000",
    });
    failed.meta.err = { InstructionError: [0, "Custom"] };
    expect(detectSwapForWallet(failed, LEADER)).toBeNull();
  });

  it("returns null when SOL and token deltas don't form a swap", () => {
    // both SOL and token went up: this is a receive, not a swap
    const s = detectSwapForWallet(
      tx({
        preSol: LAMPORTS_PER_SOL,
        postSol: 2 * LAMPORTS_PER_SOL,
        postTokenAmount: "1000000000",
      }),
      LEADER,
    );
    expect(s).toBeNull();
  });
});
