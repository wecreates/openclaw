# copy-trader-sol

A minimal Solana copy-trading bot. Point it at a list of wallets you follow; when they buy a token through any DEX (Jupiter, Raydium, Pump.fun, Meteora, Orca…), the bot buys the same token. When they sell, it sells the position it opened for that (leader, mint) pair.

## Architecture

```
Solana WS (logsSubscribe)  →  parser (pre/post balance diff)  →  risk gate  →  Jupiter v6 swap  →  sqlite state
        ↑                              ↑                                                ↓
  followed wallets                DEX-agnostic                              positions + PnL for daily-loss guard
```

- **Signal:** `logsSubscribe({ mentions: [wallet] })` fires within ~1–3 slots of a leader's tx confirming (~400ms–1.2s).
- **Parser:** diffs the leader's pre/post SOL and SPL token balances. No program-specific decoders — works on every DEX.
- **Execution:** Jupiter v6 aggregator finds the best route across all Solana DEXes and returns a signed-ready tx.
- **State:** sqlite tracks positions per `(mint, leader)` so a leader's sell only closes what you bought following *that* leader.

## Realistic latency

Leader confirms → your fill: **2–8 seconds** typical, depending on RPC and priority fee. If a token 20xes in 30s the leader still beats you. This is not front-running; it is late-mirror.

## Setup

```bash
pnpm install     # or npm install
cp .env.example .env
# edit .env — set HELIUS_API_KEY, WALLET_SECRET_KEY, FOLLOWED_WALLETS
# LEAVE DRY_RUN=1 the first time you run it
pnpm dev
```

You'll see live logs showing "leader swap detected" and "DRY_RUN quote" lines with the input/output amounts and price impact. Watch it for a full day on real wallets before flipping `DRY_RUN=0`.

## Finding wallets to follow

The bot doesn't discover wallets — you provide them. Three good starting points:

- **GMGN.ai** — https://gmgn.ai/trade — "Smart Money" tab ranks Solana wallets by 7d/30d PnL, win rate, and avg hold time. Copy addresses that show 55%+ win rate with meaningful sample size (>50 trades).
- **Cielo Finance** — https://cielo.finance — has a leaderboard and a paid API for programmatic pulling.
- **Birdeye** — https://birdeye.so — "Top Traders" per token page.

Follow 3–8 wallets across different styles (memecoin scalper, SOL-pair swinger, low-cap sniper). Copying one wallet correlates you 1:1 with that one wallet's bad day.

## Sizing modes

Set exactly one:

- `FIXED_BUY_SOL=0.05` — spend 0.05 SOL every time any followed wallet buys. Simple, predictable.
- `LEADER_PERCENT=1` — spend 1% of the leader's SOL notional. Scales with their conviction. Risky if a whale drops 100 SOL and you copy 1 SOL you weren't ready to lose.

## Safety knobs

| env | what it does |
|---|---|
| `DRY_RUN=1` | logs decisions, sends nothing |
| `DAILY_LOSS_LIMIT_SOL` | bot pauses itself if realized 24h PnL drops below `-limit` |
| `MIN_LIQUIDITY_USD` | probe-quotes 0.1 SOL against the token; skips if price impact >5% |
| `SLIPPAGE_BPS` | Jupiter route slippage tolerance |
| `BLACKLIST_MINTS` | comma-separated list of mints to never touch (paste rugs here) |

## Known limits / what to improve next

1. **No stop-loss.** If a leader HODLs to zero, so do you. Add a % trailing stop in `index.ts` after `openPosition`.
2. **Leader sizing detection is coarse.** SOL delta in the leader's tx includes tx fee + any collateral moves. Fine for full-position swaps, off for partial rebalances.
3. **No leader partial-sell handling.** If the leader sells half, we sell all. Fix: track leader's remaining balance and scale.
4. **Single RPC.** For real latency, run two connections (Helius + Triton) and race the log events; act on whichever fires first.
5. **No Jito bundling.** For sub-slot inclusion, swap `sendRawTransaction` for a Jito bundle submit.
6. **No auto-discovery.** Add a `src/discovery.ts` that pulls GMGN/Cielo leaderboards nightly and rewrites `FOLLOWED_WALLETS`.

## Warnings

- Base58 secret keys in `.env` are as dangerous as your seed phrase. Give this a fresh wallet, funded with only what you can lose.
- Copy-trading has known adverse selection: by the time you enter, price has moved against you. Expect worse fills than the leader's shown PnL.
- This is not financial advice; the code is a starting point, not a strategy.
