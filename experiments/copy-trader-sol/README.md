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
