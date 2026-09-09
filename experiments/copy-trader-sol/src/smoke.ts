import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { detectSwapForWallet } from "./parser.js";
import { log } from "./log.js";

const LEADER = "LeaderWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function fakeTx(args: {
  sig: string;
  slot: number;
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
    slot: args.slot,
    transaction: {
      signatures: [args.sig],
      message: {
        accountKeys: [{ pubkey: { toBase58: () => args.ownerKey ?? LEADER } }],
      },
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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

async function main() {
  log.info("[1] BUY: leader spends 1 SOL, receives 1000 TOKEN");
  const buy = detectSwapForWallet(
    fakeTx({
      sig: "sigBUY",
      slot: 1,
      preSol: 2 * LAMPORTS_PER_SOL,
      postSol: 1 * LAMPORTS_PER_SOL - 5000,
      postTokenAmount: "1000000000",
    }),
    LEADER,
  );
  assert(buy?.side === "buy", "expected buy");
  assert(buy?.tokenMint === TOKEN, "wrong mint");
  assert(buy?.solLamports === LAMPORTS_PER_SOL, "wrong SOL notional");
  assert(buy?.leaderPreTokenAmount === 0n, "leader had 0 pre");
  assert(buy?.leaderPostTokenAmount === 1_000_000_000n, "wrong post");
  log.info({ buy }, "ok");

  log.info("[2] FULL SELL: leader sells 1000 → 0 TOKEN, receives 1.2 SOL");
  const fullSell = detectSwapForWallet(
    fakeTx({
      sig: "sigFULL",
      slot: 2,
      preSol: 1 * LAMPORTS_PER_SOL,
      postSol: 1 * LAMPORTS_PER_SOL + 1.2 * LAMPORTS_PER_SOL - 5000,
      preTokenAmount: "1000000000",
    }),
    LEADER,
  );
  assert(fullSell?.side === "sell", "expected sell");
  assert(fullSell?.leaderPreTokenAmount === 1_000_000_000n, "wrong pre");
  assert(fullSell?.leaderPostTokenAmount === 0n, "wrong post");
  assert(fullSell?.tokenAmountRaw === 1_000_000_000n, "wrong sell amount");
  log.info({ fullSell }, "ok");

  log.info("[3] PARTIAL SELL: leader sells 500 of 1000, receives 0.6 SOL — fraction=50%");
  const partial = detectSwapForWallet(
    fakeTx({
      sig: "sigPART",
      slot: 3,
      preSol: 1 * LAMPORTS_PER_SOL,
      postSol: 1 * LAMPORTS_PER_SOL + 0.6 * LAMPORTS_PER_SOL - 5000,
      preTokenAmount: "1000000000",
      postTokenAmount: "500000000",
    }),
    LEADER,
  );
  assert(partial?.side === "sell", "expected sell");
  const fraction =
    Number((partial!.tokenAmountRaw * 10000n) / partial!.leaderPreTokenAmount) / 10000;
  assert(Math.abs(fraction - 0.5) < 1e-9, `expected 0.5 got ${fraction}`);
  log.info({ partial, fraction }, "ok");

  log.info("[4] unrelated wallet: expect null");
  const none = detectSwapForWallet(
    fakeTx({
      sig: "sigNULL",
      slot: 4,
      preSol: 1000,
      postSol: 995,
      ownerKey: "OtherWalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    }),
    LEADER,
  );
  assert(none === null, "expected null");
  log.info("ok");

  log.info("[5] failed tx: expect null");
  const errTx = fakeTx({
    sig: "sigERR",
    slot: 5,
    preSol: 2 * LAMPORTS_PER_SOL,
    postSol: 1 * LAMPORTS_PER_SOL,
    postTokenAmount: "1000000000",
  });
  errTx.meta.err = { InstructionError: [0, "Custom"] };
  const errRes = detectSwapForWallet(errTx, LEADER);
  assert(errRes === null, "expected null");
  log.info("ok");

  log.info("ALL PARSER TESTS PASSED");
}

main().catch((e) => {
  log.fatal({ err: e }, "smoke failed");
  process.exit(1);
});
