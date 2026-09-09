# copy-trader-sol

Solana copy-trading bot. Watches wallets you follow, mirrors their DEX swaps through Jupiter, protects downside with stop-loss + trailing take-profit, and shows a live dashboard.

## Architecture

```
Helius WS → parser → risk gate → Jupiter v6 swap → sqlite state → dashboard
   ↑                                                    ↓
followed wallets                                 price watcher → stop-loss / trailing TP
```

- **Watcher**: `logsSubscribe({ mentions: [wallet] })`. Latency ~1–3 slots (400ms–1.2s) after leader's tx confirms.
- **Parser**: diffs leader's pre/post SOL and SPL balances — works on any DEX (Jupiter, Raydium, Pump.fun, Meteora, Orca).
- **Execution**: Jupiter v6 aggregator routes across every Solana DEX.
- **Exits**: independent price-watch loop polls Jupiter every 20s per open position; fires stop-loss or trailing take-profit without waiting for the leader.
- **Kill switch**: create the file at `$KILL_SWITCH_PATH` (default `~/.copy-trader-kill`) and no new trades fire until you delete it.
- **Dashboard**: http://127.0.0.1:3000 — auto-refresh every 5s.

## First night — from zero to running

```bash
# 1. Install
pnpm install --ignore-workspace   # or npm install / bun install
pnpm smoke                        # parser tests, no network

# 2. Interactive setup (generates .env, optionally a fresh wallet)
pnpm setup

# 3. Fund the trading wallet with a small amount of SOL you can afford to lose.
#    The setup script prints the public address after generating the keypair.

# 4. Run in dry-run (default) and watch the dashboard for a full day
pnpm dev
open http://127.0.0.1:3000

# 5. When the dry-run log looks sane and you've seen a few leader trades echoed:
#    edit .env → DRY_RUN=0
pnpm dev

# panic button, at any time:
touch ~/.copy-trader-kill
```

## What you'll see

- Terminal: pino-pretty logs — `leader swap detected`, `DRY_RUN quote` (in dry mode), `swap sent`, `auto-exit triggered`.
- Dashboard: PnL 24h / all-time, open positions with live PnL %, recent trades.
- Telegram (if configured): every buy, sell, and auto-exit.

## Finding wallets

- **AUTO_DISCOVER=1** — pulls top 7-day PnL wallets from GMGN's public rank endpoint (filtered to >55% win rate). Endpoint shape may shift; failure falls back to your static list.
- **Manual** — GMGN.ai Smart Money tab, Cielo Finance, Birdeye "Top Traders per token". Add addresses to `FOLLOWED_WALLETS`.

Follow 3–8 across different styles. Copying one wallet correlates you 1:1 with its bad day.

## Safety design

| feature | env | what it prevents |
|---|---|---|
| Dry run | `DRY_RUN=1` | Sends nothing; logs decisions |
| Stop-loss | `STOP_LOSS_PCT=0.30` | Leader bag-holds to zero |
| Trailing TP | `TAKE_PROFIT_PCT=1.0` + `TRAILING_STOP_PCT=0.20` | Round-trip a winner |
| Max positions | `MAX_CONCURRENT_POSITIONS=5` | Over-exposure on a fast day |
| Daily loss cap | `DAILY_LOSS_LIMIT_SOL=0.5` | Bot pauses itself |
| Min leader size | `MIN_LEADER_SOL_LAMPORTS` | Skip leader's dust probes |
| Liquidity probe | `MIN_LIQUIDITY_USD` | Skip rugs/honeypots (>5% impact on 0.1 SOL) |
| Blacklist | `BLACKLIST_MINTS` | Never touch a mint you've seen scam |
| Kill switch | touch `~/.copy-trader-kill` | Instant pause without shutdown |

## Partial sells

When the leader sells `X%` of their position, we sell the same `X%` of ours (rounded to 100% if ≥95%). Parser reads their pre-tx balance from the transaction meta, so this works without a separate balance query.

## Realistic latency

Leader confirms → your fill: **2–8s** typical. If a token 20xes in 30s the leader still beats you. This is not front-running; it's late mirror. Your exits are yours, though — they run on your price-watch loop, not the leader's timing.

## Known limits

- Auto-discovery scrapes a public endpoint; a paid Cielo/Nansen key is more stable long-term.
- No Jito bundles yet — swap `sendRawTransaction` for a bundle submit if you need sub-slot inclusion.
- Single RPC. For real speed run two connections and race log events.
- No paper-simulation of stop-loss during dry-run (only real Jupiter quotes are polled).
- If you restart mid-position, the entry price persists but any live orders that need re-attempting won't retry automatically.

## Warnings

- Base58 secret keys are as dangerous as your seed phrase. Use a fresh wallet, fund with what you can lose.
- Copy-trading has known adverse selection: by the time you enter, price has already moved against you. Expect worse fills than the leader's reported PnL. A 60% win-rate leader may map to a break-even bot after slippage and fees.
- This is a starting point, not a strategy. Paper-trade for at least 24h and start with 0.01–0.02 SOL per trade.
