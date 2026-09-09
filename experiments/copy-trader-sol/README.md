# copy-trader-sol

Solana copy-trading bot. Watches wallets you follow, mirrors their DEX swaps through Jupiter (with optional Jito bundles for MEV protection), gates every trade through nine safety checks, exits with independent stop-loss + trailing take-profit + max-age, drops leaders who cost you money, and exposes a live dashboard, Prometheus metrics, and a CLI.

## Architecture

```
   Helius WS  ─►  parser  ─►  ┌─── mute + kill-switch + daily-loss + max-positions
(auto-reconnect)               │
                               ├── blacklist / leader-dust / mint-cooldown / leader-cooldown
                               │
                               ├── token-age gate (skip mints < N minutes old)
                               │
                               ├── rug check (mint authority · freeze authority · top holder)
                               │
                               ├── liquidity probe (Jupiter 0.1-SOL impact)
                               │
                               └── consensus (N distinct leaders in a rolling window)
                                          │
                                          ▼
                                     Jupiter v6 quote
                                          │
                                          ▼
                              ┌── Jito bundle (+tip) ─┐
                              └── multi-RPC race     ─┴──► confirm
                                          │
                                          ▼
                                  sqlite: positions
                                          │
                                          ▼
             ┌────────────────────────────┼─────────────────────────────┐
             │                            │                             │
       price watcher                  scoring                    dashboard
   (stop / trail / age)     (auto-mute losing leaders)     · metrics · CLI · CSV
```

## Deeper safety and analytics (v0.6)

- **Enhanced rug check** — the on-chain mint/freeze/top-holder check is now layered with a GeckoTerminal pool query: reserve floor, 24h volume floor, minimum pool age, low-GT-score suspicion. Blocking rug reasons emit deduplicated Telegram/Discord alerts.
- **Buy retry queue** — a failed initial buy is enqueued with a short TTL (60s default) and 3 backoff attempts (5s → 15s → 30s). Stale signals drop; successful retries land normally and mark the leader cooldown.
- **Dynamic priority fee** — set `PRIORITY_FEE_DYNAMIC=1` and every swap asks Helius's `getPriorityFeeEstimate` for the "high" percentile, capped by `PRIORITY_FEE_MICROLAMPORTS_MAX`, cached for 3s. Falls back silently to the static value on failure.
- **Portfolio allocation gates** — `MAX_PERCENT_PER_MINT` and `MAX_PERCENT_PER_LEADER` (fractions of invested SOL notional). First position always passes (otherwise a single-position portfolio would always block).
- **Alert dedup** — `notifyDedup(key, msg)` collapses repeat alerts under the same key within a window, then emits a summary line ("and N more rug-skip in the last 300s") when the window closes.
- **Analytics** — `pnpm cli analyze [leaders|mints|hours]` — per-key trade count, winrate, net PnL. Hour-of-day is UTC-bucketed, useful for spotting session-window effects (US, Asia, EU).
- **Status CLI now shows queue depth** — `pnpm cli status` includes buy + sell queue lengths.

## Operational safety (v0.5)

- **Pending swap ledger** — every send is recorded before broadcast (signature + blockhash + last-valid-height). On restart, `recoverPending()` asks the RPC what happened to each: landed cleanly (reconcile picks up on-chain position), confirmed with error, blockhash expired, or still in flight.
- **Actual fill parsing** — after confirm, we diff our own pre/post SOL + SPL balances to record the *actual* execution price, not the quote's projection. Slippage vs quote is stored on every trade and logged when it exceeds tolerance.
- **Sell retry queue** — a stop-loss / trailing exit that fails at execute time gets enqueued with exponential backoff (30s → 90s → 5m → 15m → 1h). Background worker processes due items every 15s. Recovers if leader-side selling would have missed the exit.
- **Orphaned wSOL cleanup** — on startup (unless `WSOL_CLEANUP_ON_START=0`), close the wallet's wSOL ATA if it holds any residual balance from a failed Jupiter swap.
- **Wallet balance monitor** — polls the trading wallet every N minutes; alerts once per cooldown window when balance drops below threshold.
- **DB migrations** — versioned schema in `schema_version`. Each migration runs once, in order; safe on both fresh and legacy DBs (`ALTER … ADD COLUMN` failures are swallowed only for "duplicate column").
- **Log rotation** — set `LOG_FILE=./data/logs/bot.log` and each day's process gets its own `bot.<YYYY-MM-DD>.log`. Terminal output continues via pino-pretty.
- **/healthz** — Kubernetes-style probe on the dashboard port. Returns `ok`, `degraded` (kill-switch, or price-watcher hasn't ticked in 5 min while positions are open), or `down`.
- **Historical backtest** — `pnpm backtest trades.json` now uses GeckoTerminal minute candles to compute *actual* PnL, drawdown, best/worst trade, per-exit-reason breakdown. Uses the same stop / trailing TP / max-age exit rules the live bot uses.

## Feature list

- **Signal** — Helius `logsSubscribe` per followed wallet, 15s RPC heartbeat, full resubscribe on failure.
- **Parser** — DEX-agnostic pre/post balance diff. Returns leader's pre-token balance so partial sells scale correctly.
- **Execution** — Jupiter v6 aggregator. Priority fee auto-doubles on retry up to a cap. Optional Jito bundle path with tip. Optional multi-RPC racing via `EXTRA_RPC_URLS`.
- **Gates** — muted leaders, kill switch, daily loss cap, max concurrent positions, blacklist, min leader notional, per-mint re-entry cooldown, per-leader re-buy cooldown, min token age (with strict mode), rug check, liquidity probe, N-leader consensus.
- **Exits** — independent 20s price poll: stop-loss, take-profit trigger + trailing stop, max-position-age hours.
- **Auto-mute** — after N closed sells, if leader's net PnL negative AND (winrate below floor OR loss streak), auto-mute.
- **Startup reconcile** — every DB position synced with on-chain balance (drops phantoms, adjusts partials).
- **Discovery** — pulls top 7-day wallets from GMGN's public rank endpoint when `AUTO_DISCOVER=1`.
- **Alerts** — Telegram and Discord webhooks in parallel.
- **Dashboard** — `http://127.0.0.1:3000`, 5s refresh, SOL/USD-priced PnL.
- **Metrics** — `http://127.0.0.1:9090/metrics`, Prometheus text format.
- **CLI** — `pnpm cli { status | positions | trades | leaders | mute | unmute | mutes | export }`.
- **Backtest** — `pnpm backtest trades.json` replays a JSON of leader swaps against current Jupiter quotes to shape-test the strategy.
- **Tests** — Vitest, 25 cases across parser, scoring, HTTP retry, consensus, cooldown, and CSV export.

## First night — from zero to running

```bash
pnpm install --ignore-workspace
pnpm test                          # 25 unit tests, no network
pnpm setup                         # interactive wizard: writes .env, can generate a wallet

# fund the wallet address the wizard prints with SOL you can afford to lose

pnpm dev                           # DRY_RUN=1 by default
open http://127.0.0.1:3000         # dashboard
curl localhost:9090/metrics        # Prometheus scrape

# in another terminal:
pnpm cli status
pnpm cli leaders
pnpm cli export ./data/trades.csv

# after 24h of clean dry-run: edit .env → DRY_RUN=0, restart

# panic button, any time:
touch ~/.copy-trader-kill
```

## Environment cheatsheet (highlights)

| var | default | effect |
|---|---|---|
| `DRY_RUN` | `1` | Send no transactions |
| `FIXED_BUY_SOL` | `0.02` | SOL per copied buy |
| `MAX_CONCURRENT_POSITIONS` | `5` | Hard cap |
| `MIN_LEADER_SOL_LAMPORTS` | `1e8` | Skip leader's dust buys |
| `STOP_LOSS_PCT` | `0.30` | |
| `TAKE_PROFIT_PCT` / `TRAILING_STOP_PCT` | `1.0` / `0.20` | |
| `MAX_POSITION_AGE_HOURS` | `0` | Auto-exit stale positions (0=off) |
| `PRIORITY_FEE_MICROLAMPORTS` / `_MAX` | `100k` / `2M` | Auto-doubles on retry |
| `EXECUTION_MAX_ATTEMPTS` | `3` | Swap retry ceiling |
| `JITO_ENABLED` / `JITO_TIP_LAMPORTS` | `0` / `10000` | Bundle submission with tip |
| `EXTRA_RPC_URLS` | `` | Comma-separated extra senders for race |
| `MIN_TOKEN_AGE_MINUTES` | `5` | Skip fresh-mint traps |
| `CONSENSUS_MIN_LEADERS` / `_WINDOW_SEC` | `1` / `90` | N-of-K within window |
| `MINT_REENTRY_COOLDOWN_MINUTES` | `60` | Don't rebuy right after selling |
| `LEADER_REBUY_COOLDOWN_MINUTES` | `5` | Don't ladder into leader's fills |
| `RUG_CHECK_ENABLED` | `1` | Mint/freeze authority + top holder |
| `AUTO_MUTE_*` | `on, 5, 0.35, 4` | Drop losing leaders |
| `DAILY_LOSS_LIMIT_SOL` | `0.5` | Bot pauses itself |
| `KILL_SWITCH_PATH` | `~/.copy-trader-kill` | Touch to pause |
| `AUTO_DISCOVER` | `0` | GMGN top wallets |
| `TELEGRAM_*` / `DISCORD_WEBHOOK_URL` | `` | Alerts |
| `ENABLE_DASHBOARD` / `DASHBOARD_PORT` | `1` / `3000` | HTML UI |
| `ENABLE_METRICS` / `METRICS_PORT` | `1` / `9090` | Prometheus |

## Backtest

```bash
# trades.json is an array of { ts, leader, mint, side, leaderSol, leaderTokenAmount, leaderPreTokenAmount? }
pnpm backtest trades.json --size 0.02 --max-positions 5 --mint-cd 60 --leader-cd 5
```

Note: Jupiter serves current quotes only, so replay simulates strategy shape (what would have been sized / blocked / auto-muted), not actual historical PnL. For real PnL you need Birdeye/GeckoTerminal/Jupiter Pro archival prices.

## Realistic latency

Leader confirms → your fill: **2–8s** typical without Jito, ~1–3s with Jito bundles + tip. Exits are yours (price-watch loop, not leader-timed).

## Deployment

- **systemd**: `deploy/systemd/copy-trader.service` — copy to `/etc/systemd/system/`, `systemctl enable --now copy-trader`.
- **Docker**: `deploy/docker/Dockerfile` + `docker-compose.yml`. Multi-stage build, runs as `node` user, healthcheck hits `/healthz`, data persisted in a named volume, bot log rotation via json-file driver.

## Known limits / possible next rounds

- **Historical price feed** for real backtest PnL (Birdeye Pro / GeckoTerminal API).
- **WS race** across providers (send/subscribe races currently one direction only).
- **DB migrations** — schema is stable but not versioned yet.
- **Cost basis** — proportional per partial sell; not FIFO.
- **Signal quality scoring** — holder count and LP burn status could gate buys too.
- **Prometheus histogram for latency** — currently only counters + gauges.

## Warnings

- Base58 secret keys are as dangerous as your seed phrase. Fresh wallet, funded with what you can lose.
- Copy-trading has adverse selection. A 60% win-rate leader can map to a break-even bot after slippage + fees.
- Start with `FIXED_BUY_SOL=0.01`, `CONSENSUS_MIN_LEADERS=2` for extra caution. Don't scale up until 20+ real trades survive.
