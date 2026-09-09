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
  log.info({ buy }, "detected");
  assert(buy?.side === "buy", "expected buy");
  assert(buy?.tokenMint === TOKEN, "wrong mint");
  assert(buy?.solLamports === LAMPORTS_PER_SOL, "wrong SOL notional");

  log.info("[2] SELL: leader sends 500 TOKEN, receives 0.6 SOL");
  const sell = detectSwapForWallet(
    fakeTx({
      sig: "sigSELL",
      slot: 2,
      preSol: 1 * LAMPORTS_PER_SOL,
      postSol: 1 * LAMPORTS_PER_SOL + 0.6 * LAMPORTS_PER_SOL - 5000,
      preTokenAmount: "1000000000",
      postTokenAmount: "500000000",
    }),
    LEADER,
  );
  log.info({ sell }, "detected");
  assert(sell?.side === "sell", "expected sell");
  assert(sell?.tokenAmountRaw === 500000000n, "wrong token amount sold");

  log.info("[3] unrelated tx (different wallet): expect null");
  const none = detectSwapForWallet(
    fakeTx({
      sig: "sigNULL",
      slot: 3,
      preSol: 1000,
      postSol: 995,
      ownerKey: "OtherWalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    }),
    LEADER,
  );
  log.info({ none }, "detected");
  assert(none === null, "expected null for unrelated tx");

  log.info("[4] failed tx (meta.err set): expect null");
  const errTx = fakeTx({
    sig: "sigERR",
    slot: 4,
    preSol: 2 * LAMPORTS_PER_SOL,
    postSol: 1 * LAMPORTS_PER_SOL,
    postTokenAmount: "1000000000",
  });
  errTx.meta.err = { InstructionError: [0, "Custom"] };
  const errRes = detectSwapForWallet(errTx, LEADER);
  log.info({ errRes }, "detected");
  assert(errRes === null, "expected null for failed tx");

  log.info("ALL PARSER TESTS PASSED");
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

main().catch((e) => {
  log.fatal({ err: e }, "smoke failed");
  process.exit(1);
});
