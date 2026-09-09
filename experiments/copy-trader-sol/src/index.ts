import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { loadKeypair } from "./wallet.js";
import { watchWallets } from "./watcher.js";
import { buy, sell } from "./executor.js";
import {
  closePosition,
  getPosition,
  openPosition,
  recordTrade,
  updatePositionAmount,
} from "./state.js";
import {
  isBlacklisted,
  leaderTradeTooSmall,
  passesLiquidity,
  preTradeGate,
  sizeBuyLamports,
} from "./risk.js";
import { runPreflight } from "./preflight.js";
import { resolveWallets } from "./discovery.js";
import { startPriceWatcher } from "./pricewatch.js";
import { startDashboard } from "./dashboard.js";
import { fmtSol, notify } from "./notify.js";

async function main() {
  const kp = loadKeypair();
  const conn = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: config.wsUrl,
  });

  log.info(
    { wallet: kp.publicKey.toBase58(), dryRun: config.dryRun },
    "starting copy-trader",
  );

  const pf = await runPreflight(conn, kp.publicKey);
  for (const w of pf.warnings) log.warn(w);
  for (const e of pf.errors) log.error(e);
  if (!pf.ok) {
    log.fatal("preflight failed — fix errors above and retry");
    process.exit(1);
  }

  let wallets = await resolveWallets();
  if (wallets.length === 0) {
    log.fatal("no wallets to follow after discovery");
    process.exit(1);
  }
  log.info({ count: wallets.length }, "resolved followed wallets");

  const stopWatcher = watchWallets(conn, wallets, async (swap) => {
    const gate = preTradeGate(swap.side);
    if (gate) {
      log.warn({ reason: gate, swap: swap.tokenMint }, "skipping");
      return;
    }
    if (isBlacklisted(swap.tokenMint)) {
      log.info({ mint: swap.tokenMint }, "skipping: blacklisted");
      return;
    }

    try {
      if (swap.side === "buy") {
        if (leaderTradeTooSmall(swap.solLamports)) {
          log.info(
            { mint: swap.tokenMint, sol: swap.solLamports / LAMPORTS_PER_SOL },
            "skipping: leader trade below min notional",
          );
          return;
        }
        if (!(await passesLiquidity(swap.tokenMint))) {
          log.info({ mint: swap.tokenMint }, "skipping: illiquid");
          return;
        }
        const size = sizeBuyLamports(swap.solLamports);
        if (size <= 0) {
          log.warn("skipping: no sizing configured");
          return;
        }
        const res = await buy(conn, kp, swap.tokenMint, size);
        openPosition({
          mint: swap.tokenMint,
          leader: swap.leader,
          amountRaw: res.tokenAmountRaw.toString(),
          solSpentLamports: res.solLamports,
          openedAt: Date.now(),
          txSig: res.signature,
          entryPriceSolPerToken: res.pricePerToken,
          peakPriceSolPerToken: res.pricePerToken,
          lastPriceSolPerToken: res.pricePerToken,
        });
        recordTrade({
          side: "buy",
          mint: swap.tokenMint,
          leader: swap.leader,
          solDeltaLamports: -res.solLamports,
          txSig: res.signature,
          reason: `copy ${swap.leader.slice(0, 6)}`,
        });
        notify(
          `🟢 buy *${swap.tokenMint.slice(0, 6)}…* via ${swap.leader.slice(0, 6)}\nspent ${fmtSol(res.solLamports)} SOL`,
        );
      } else {
        const pos = getPosition(swap.tokenMint, swap.leader);
        if (!pos) {
          log.info(
            { mint: swap.tokenMint, leader: swap.leader },
            "leader sold token we don't hold from them — skipping",
          );
          return;
        }
        const held = BigInt(pos.amountRaw);
        const soldByLeader = swap.tokenAmountRaw;
        const leaderPre = swap.leaderPreTokenAmount;
        const fraction =
          leaderPre > 0n
            ? Number((soldByLeader * 10000n) / leaderPre) / 10000
            : 1;
        const sellAmount = fraction >= 0.95
          ? held
          : BigInt(Math.floor(Number(held) * fraction));
        if (sellAmount <= 0n) {
          log.info("computed sell amount 0 — skipping");
          return;
        }
        const isFullExit = sellAmount === held;
        const res = await sell(conn, kp, swap.tokenMint, sellAmount);
        if (isFullExit) {
          closePosition(swap.tokenMint, swap.leader);
        } else {
          const remaining = held - sellAmount;
          const remainingCost = Math.floor(
            pos.solSpentLamports * (1 - Number(sellAmount) / Number(held)),
          );
          updatePositionAmount(
            swap.tokenMint,
            swap.leader,
            remaining.toString(),
            remainingCost,
          );
        }
        const realized = isFullExit
          ? res.solLamports - pos.solSpentLamports
          : res.solLamports -
            Math.floor(
              pos.solSpentLamports * (Number(sellAmount) / Number(held)),
            );
        recordTrade({
          side: "sell",
          mint: swap.tokenMint,
          leader: swap.leader,
          solDeltaLamports: realized,
          txSig: res.signature,
          reason: `follow ${swap.leader.slice(0, 6)} sell${isFullExit ? "" : ` ${(fraction * 100).toFixed(0)}%`}`,
        });
        notify(
          `🔴 sell *${swap.tokenMint.slice(0, 6)}…* (${isFullExit ? "full" : `${(fraction * 100).toFixed(0)}%`}) via ${swap.leader.slice(0, 6)}\nrealized ${fmtSol(realized)} SOL`,
        );
      }
    } catch (err) {
      log.error({ err, swap }, "execution failed");
      notify(`⚠️ execution failed for ${swap.tokenMint.slice(0, 6)}…: ${(err as Error).message}`);
    }
  });

  const stopPrice = startPriceWatcher(conn, kp);
  const stopDash = config.enableDashboard
    ? startDashboard(kp.publicKey)
    : () => {};

  if (config.autoDiscover && config.autoDiscoverRefreshMinutes > 0) {
    setInterval(async () => {
      const fresh = await resolveWallets();
      if (fresh.length > wallets.length || fresh.some((w) => !wallets.includes(w))) {
        log.info({ before: wallets.length, after: fresh.length }, "wallet list changed — restart to apply");
        wallets = fresh;
      }
    }, config.autoDiscoverRefreshMinutes * 60_000);
  }

  const shutdown = async (why: string) => {
    log.info({ why }, "shutting down");
    await stopWatcher();
    stopPrice();
    stopDash();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  notify(`🚀 copy-trader started · dryRun=${config.dryRun} · following ${wallets.length}`);
}

main().catch((err) => {
  log.fatal({ err }, "fatal");
  process.exit(1);
});
