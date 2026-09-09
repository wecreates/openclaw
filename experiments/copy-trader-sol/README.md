# copy-trader-sol

Solana copy-trading bot. Watches wallets you follow, mirrors their DEX swaps through Jupiter, protects downside with stop-loss + trailing take-profit, drops leaders who cost you money, and shows a live dashboard.

## Architecture

```
Helius WS (auto-reconnect) → parser → risk gate → Jupiter v6 swap → sqlite
      ↑                                       ↑                        ↓
followed wallets              rug check · liquidity            price watcher
      ↑                       min leader size                  · stop-loss
GMGN top wallets              blacklist · kill switch          · trailing TP
                              muted leaders                      · exits
                                                                    ↓
                                                            leader scorer
                                                                    ↓
                                                            auto-mute losers
```

- **Watcher** — `logsSubscribe({ mentions: [wallet] })` with a 15s heartbeat and full resubscribe on RPC failure.
- **Parser** — diffs the leader's pre/post SOL and SPL balances, DEX-agnostic. Returns `leaderPre/PostTokenAmount` so partial sells scale correctly.
- **Rug check** — before every buy: mint authority must be null (no printing), freeze authority must be null (no wallet freeze), top holder <40%.
- **Execution** — Jupiter v6 aggregator with priority fee; retrying HTTP wrapper handles transient 5xx/timeouts.
- **Reconciliation on startup** — walks every open position and syncs its `amount_raw` with the wallet's on-chain balance (drops phantoms, adjusts partials).
- **Exits** — 20s price poll per open position; independent stop-loss + trailing take-profit.
- **Auto-mute** — after N closed sells, if a leader's net PnL is negative AND (winrate below floor OR loss streak), they're muted and won't be copied again.
- **Kill switch** — create `~/.copy-trader-kill`; no new trades until you delete it.
- **Dashboard** — http://127.0.0.1:3000, 5s refresh.
- **CLI** — `pnpm cli status | positions | trades | leaders | mute | unmute | mutes`.

## First night — from zero to running

```bash
pnpm install --ignore-workspace
pnpm test                          # 16 unit tests, no network
pnpm setup                         # interactive: writes .env, can generate a wallet

# fund the wallet address the setup script prints with SOL you can afford to lose

pnpm dev                           # DRY_RUN=1 by default
open http://127.0.0.1:3000

# in another terminal:
pnpm cli status                    # PnL & open positions
pnpm cli leaders                   # per-leader stats
pnpm cli mute <addr> reason        # manually drop a leader

# after ~24h of clean dry-run: edit .env → DRY_RUN=0, pnpm dev

# panic button, any time:
touch ~/.copy-trader-kill
```

## Environment cheatsheet

| var | default | effect |
|---|---|---|
| `DRY_RUN` | `1` | Send no transactions |
| `FIXED_BUY_SOL` | `0.02` | SOL per copied buy (overrides percent) |
| `LEADER_PERCENT` | `0` | Or copy N% of leader's SOL notional |
| `MAX_CONCURRENT_POSITIONS` | `5` | Hard cap |
| `MIN_LEADER_SOL_LAMPORTS` | `1e8` | Skip leader's dust buys (<0.1 SOL) |
| `STOP_LOSS_PCT` | `0.30` | Exit if -30% from entry |
| `TAKE_PROFIT_PCT` | `1.0` | Arm trailing stop at +100% |
| `TRAILING_STOP_PCT` | `0.20` | Exit if -20% off peak once TP armed |
| `PRICE_CHECK_INTERVAL_SEC` | `20` | Price-watch cadence |
| `DAILY_LOSS_LIMIT_SOL` | `0.5` | Bot pauses itself |
| `SLIPPAGE_BPS` | `150` | 1.5% |
| `PRIORITY_FEE_MICROLAMPORTS` | `100000` | Higher = faster inclusion |
| `RUG_CHECK_ENABLED` | `1` | Block mintable/freezable/concentrated tokens |
| `AUTO_MUTE_ENABLED` | `1` | Drop leaders who lose money |
| `AUTO_MUTE_MIN_TRADES` | `5` | Sample size before muting |
| `AUTO_MUTE_WIN_RATE_FLOOR` | `0.35` | Auto-mute below this winrate |
| `AUTO_MUTE_LOSS_STREAK` | `4` | Or after this many consecutive losers |
| `BLACKLIST_MINTS` | `` | Comma-separated mints never to touch |
| `KILL_SWITCH_PATH` | `~/.copy-trader-kill` | Touch this file to pause |
| `AUTO_DISCOVER` | `0` | Pull top wallets from GMGN |
| `AUTO_DISCOVER_COUNT` | `5` | Number of wallets to pull |
| `AUTO_DISCOVER_REFRESH_MINUTES` | `240` | Refresh cadence |
| `TELEGRAM_BOT_TOKEN` / `_CHAT_ID` | `` | Optional Telegram alerts |
| `DASHBOARD_PORT` | `3000` | HTTP dashboard |

## Realistic latency

Leader confirms → your fill: **2–8s** typical. If a token 20xes in 30s the leader still beats you. This is not front-running; it's late mirror. Your exits are yours, though — they run on your price-watch loop, not the leader's timing.

## Testing

- `pnpm test` — Vitest suite: parser (buy/sell/partial/failed-tx/edge cases), scoring (auto-mute logic), http (retry & non-retry).
- `pnpm smoke` — legacy parser assertions via tsx.
- `pnpm typecheck` — full project.

## Known limits / next up

- **Jito bundles** — swap `sendRawTransaction` for a Jito bundle submit for sub-slot inclusion.
- **Multi-RPC racing** — run two providers and take whichever confirms first.
- **Backtest** — replay leader txs against Jupiter's price history. Big project.
- **Fresh-token gate** — no `getSignaturesForAddress` age check yet; consider skipping tokens <5 minutes old.
- **Cost basis** — currently proportional per partial sell; not full FIFO.

## Warnings

- Base58 secret keys are as dangerous as your seed phrase. Fresh wallet, funded with what you can lose.
- Copy-trading has adverse selection: by the time you enter, price has already moved against you. A 60% win-rate leader can map to a break-even bot after slippage and fees.
- Start with `FIXED_BUY_SOL=0.01`. Don't scale up until you've seen 20+ real trades survive.
