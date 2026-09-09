import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
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
  try { new PublicKey(w); } catch { throw new Error(`Invalid followed wallet: ${w}`); }
}

export const config = {
  rpcUrl: req("RPC_URL"),
  wsUrl: req("WS_URL"),
  walletSecret: req("WALLET_SECRET_KEY"),

  followedWallets: followed,
  autoDiscover: bool("AUTO_DISCOVER", false),
  autoDiscoverCount: num("AUTO_DISCOVER_COUNT", 5),
  autoDiscoverRefreshMinutes: num("AUTO_DISCOVER_REFRESH_MINUTES", 240),

  fixedBuySol: num("FIXED_BUY_SOL", 0),
  leaderPercent: num("LEADER_PERCENT", 0),
  maxConcurrentPositions: num("MAX_CONCURRENT_POSITIONS", 5),

  dailyLossLimitSol: num("DAILY_LOSS_LIMIT_SOL", 0.5),
  slippageBps: num("SLIPPAGE_BPS", 150),
  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 25000),

  priorityFeeMicrolamports: num("PRIORITY_FEE_MICROLAMPORTS", 100000),
  priorityFeeMicrolamportsMax: num("PRIORITY_FEE_MICROLAMPORTS_MAX", 2_000_000),
  executionMaxAttempts: num("EXECUTION_MAX_ATTEMPTS", 3),

  stopLossPct: num("STOP_LOSS_PCT", 0.3),
  takeProfitPct: num("TAKE_PROFIT_PCT", 1.0),
  trailingStopPct: num("TRAILING_STOP_PCT", 0.2),
  priceCheckIntervalSec: num("PRICE_CHECK_INTERVAL_SEC", 20),
  maxPositionAgeHours: num("MAX_POSITION_AGE_HOURS", 0),

  minLeaderSolLamports: num("MIN_LEADER_SOL_LAMPORTS", 100_000_000),

  minTokenAgeMinutes: num("MIN_TOKEN_AGE_MINUTES", 5),
  strictTokenAge: bool("STRICT_TOKEN_AGE", false),

  consensusMinLeaders: num("CONSENSUS_MIN_LEADERS", 1),
  consensusWindowSec: num("CONSENSUS_WINDOW_SEC", 90),

  mintReentryCooldownMinutes: num("MINT_REENTRY_COOLDOWN_MINUTES", 60),
  leaderRebuyCooldownMinutes: num("LEADER_REBUY_COOLDOWN_MINUTES", 5),

  rugCheckEnabled: bool("RUG_CHECK_ENABLED", true),

  autoMuteEnabled: bool("AUTO_MUTE_ENABLED", true),
  autoMuteMinTrades: num("AUTO_MUTE_MIN_TRADES", 5),
  autoMuteWinRateFloor: num("AUTO_MUTE_WIN_RATE_FLOOR", 0.35),
  autoMuteLossStreak: num("AUTO_MUTE_LOSS_STREAK", 4),

  jitoEnabled: bool("JITO_ENABLED", false),
  jitoBlockEngineUrl: opt("JITO_BLOCK_ENGINE_URL") ??
    "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  jitoTipLamports: num("JITO_TIP_LAMPORTS", 10_000),

  killSwitchPath:
    opt("KILL_SWITCH_PATH") ?? `${process.env.HOME ?? ""}/.copy-trader-kill`,

  telegramBotToken: opt("TELEGRAM_BOT_TOKEN"),
  telegramChatId: opt("TELEGRAM_CHAT_ID"),
  discordWebhookUrl: opt("DISCORD_WEBHOOK_URL"),

  dashboardPort: num("DASHBOARD_PORT", 3000),
  enableDashboard: bool("ENABLE_DASHBOARD", true),
  metricsPort: num("METRICS_PORT", 9090),
  enableMetrics: bool("ENABLE_METRICS", true),

  walletBalanceAlertSol: num("WALLET_BALANCE_ALERT_SOL", 0.05),
  balanceCheckIntervalMinutes: num("BALANCE_CHECK_INTERVAL_MINUTES", 10),
  balanceAlertCooldownHours: num("BALANCE_ALERT_COOLDOWN_HOURS", 6),

  wsolCleanupOnStart: bool("WSOL_CLEANUP_ON_START", true),

  logFile: opt("LOG_FILE"),

  dryRun: bool("DRY_RUN", true),
  logLevel: process.env.LOG_LEVEL ?? "info",
} as const;

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
