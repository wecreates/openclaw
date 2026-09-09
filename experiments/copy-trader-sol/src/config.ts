import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} is not a number: ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

const followed = (process.env.FOLLOWED_WALLETS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const w of followed) {
  try {
    new PublicKey(w);
  } catch {
    throw new Error(`Invalid followed wallet: ${w}`);
  }
}

export const config = {
  rpcUrl: req("RPC_URL"),
  wsUrl: req("WS_URL"),
  walletSecret: req("WALLET_SECRET_KEY"),
  followedWallets: followed,
  fixedBuySol: num("FIXED_BUY_SOL", 0),
  leaderPercent: num("LEADER_PERCENT", 0),
  dailyLossLimitSol: num("DAILY_LOSS_LIMIT_SOL", 0.5),
  slippageBps: num("SLIPPAGE_BPS", 150),
  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 25000),
  priorityFeeMicrolamports: num("PRIORITY_FEE_MICROLAMPORTS", 100000),
  dryRun: bool("DRY_RUN", true),
  logLevel: process.env.LOG_LEVEL ?? "info",
} as const;

export const SOL_MINT = "So11111111111111111111111111111111111111112";
