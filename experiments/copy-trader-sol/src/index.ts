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
import { reconcilePositions } from "./reconcile.js";
import { isBlockingRug, rugCheck } from "./rugcheck.js";
import { evaluateAutoMute, isMuted } from "./scoring.js";
import { passesTokenAge } from "./tokenage.js";
import { registerBuyIntent } from "./consensus.js";
import {
  leaderOnCooldown,
  markLeaderBought,
  markMintSold,
  mintOnCooldown,
} from "./cooldown.js";
import { startMetrics, incr } from "./metrics.js";
import { raceSendersReady } from "./rpc.js";

async function main() {
  const kp = loadKeypair();
  const conn = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: config.wsUrl,
  });

  log.info(
    {
      wallet: kp.publicKey.toBase58(),
      dryRun: config.dryRun,
      jito: config.jitoEnabled,
      extraSenders: raceSendersReady(),
    },
    "starting copy-trader",
  );

  const pf = await runPreflight(conn, kp.publicKey);
  for (const w of pf.warnings) log.warn(w);
  for (const e of pf.errors) log.error(e);
  if (!pf.ok) {
    log.fatal("preflight failed — fix errors above and retry");
    process.exit(1);
  }

  await reconcilePositions(conn, kp.publicKey);

  let wallets = await resolveWallets();
  if (wallets.length === 0) {
    log.fatal("no wallets to follow after discovery");
    process.exit(1);
  }
  log.info({ count: wallets.length }, "resolved followed wallets");

  const stopWatcher = watchWallets(conn, wallets, async (swap) => {
    incr("leader_swaps_seen_total");
    if (isMuted(swap.leader)) {
      incr("skipped_muted_total"); return;
    }
    const gate = preTradeGate(swap.side);
    if (gate) {
      log.warn({ reason: gate, mint: swap.tokenMint }, "skipping");
      incr("skipped_gate_total");
      return;
    }
    if (isBlacklisted(swap.tokenMint)) {
      incr("skipped_blacklist_total"); return;
    }

    try {
      if (swap.side === "buy") {
        if (leaderTradeTooSmall(swap.solLamports)) {
          incr("skipped_leader_dust_total"); return;
        }
        if (mintOnCooldown(swap.tokenMint)) {
          log.info({ mint: swap.tokenMint }, "skipping: mint on cooldown after prior sell");
          incr("skipped_mint_cooldown_total"); return;
        }
        if (leaderOnCooldown(swap.leader)) {
          incr("skipped_leader_cooldown_total"); return;
        }

        const age = await passesTokenAge(conn, swap.tokenMint);
        if (!age.ok) {
          log.info(
            { mint: swap.tokenMint, ageMinutes: age.ageMinutes },
            "skipping: token too young",
          );
          incr("skipped_token_age_total");
          return;
        }

        if (config.rugCheckEnabled) {
          const rug = await rugCheck(conn, swap.tokenMint);
          if (isBlockingRug(rug)) {
            log.warn({ mint: swap.tokenMint, reasons: rug.reasons }, "skipping: rug check failed");
            notify(
              `⚠️ skipped *${swap.tokenMint.slice(0, 6)}…*\nrug: ${rug.reasons.join("; ")}`,
            );
            incr("skipped_rug_total");
            return;
          }
        }

        if (!(await passesLiquidity(swap.tokenMint))) {
          incr("skipped_liquidity_total"); return;
        }

        const consensus = registerBuyIntent(swap.tokenMint, swap.leader);
        if (!consensus.cleared) {
          log.info(
            { mint: swap.tokenMint, need: config.consensusMinLeaders, have: consensus.leaders.length },
            "buy queued: waiting for consensus",
          );
          incr("consensus_waiting_total");
          return;
        }

        const size = sizeBuyLamports(swap.solLamports);
        if (size <= 0) {
          log.warn("skipping: no sizing configured"); return;
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
          reason: `copy ${swap.leader.slice(0, 6)} · ${res.route}`,
        });
        markLeaderBought(swap.leader);
        incr("buys_total");
        notify(
          `🟢 buy *${swap.tokenMint.slice(0, 6)}…* via ${swap.leader.slice(0, 6)}\nspent ${fmtSol(res.solLamports)} SOL · ${res.route}`,
        );
      } else {
        const pos = getPosition(swap.tokenMint, swap.leader);
        if (!pos) return;
        const held = BigInt(pos.amountRaw);
        const soldByLeader = swap.tokenAmountRaw;
        const leaderPre = swap.leaderPreTokenAmount;
        const fraction =
          leaderPre > 0n
            ? Number((soldByLeader * 10000n) / leaderPre) / 10000
            : 1;
        const sellAmount =
          fraction >= 0.95 ? held : BigInt(Math.floor(Number(held) * fraction));
        if (sellAmount <= 0n) return;
        const isFullExit = sellAmount === held;
        const res = await sell(conn, kp, swap.tokenMint, sellAmount);
        const proportionalCost = Math.floor(
          pos.solSpentLamports * (Number(sellAmount) / Number(held)),
        );
        if (isFullExit) {
          closePosition(swap.tokenMint, swap.leader);
          markMintSold(swap.tokenMint);
        } else {
          const remaining = held - sellAmount;
          const remainingCost = pos.solSpentLamports - proportionalCost;
          updatePositionAmount(
            swap.tokenMint,
            swap.leader,
            remaining.toString(),
            remainingCost,
          );
        }
        const realized = res.solLamports - proportionalCost;
        recordTrade({
          side: "sell",
          mint: swap.tokenMint,
          leader: swap.leader,
          solDeltaLamports: realized,
          txSig: res.signature,
          reason: `follow ${swap.leader.slice(0, 6)} sell${isFullExit ? "" : ` ${(fraction * 100).toFixed(0)}%`} · ${res.route}`,
        });
        incr("sells_total");
        notify(
          `🔴 sell *${swap.tokenMint.slice(0, 6)}…* (${isFullExit ? "full" : `${(fraction * 100).toFixed(0)}%`}) via ${swap.leader.slice(0, 6)}\nrealized ${fmtSol(realized)} SOL · ${res.route}`,
        );
        if (config.autoMuteEnabled) {
          const mute = evaluateAutoMute(swap.leader, {
            minTrades: config.autoMuteMinTrades,
            winRateFloor: config.autoMuteWinRateFloor,
            maxLossStreak: config.autoMuteLossStreak,
          });
          if (mute.muted) {
            log.warn({ leader: swap.leader, reason: mute.reason }, "auto-muted leader");
            notify(`🔇 muted ${swap.leader.slice(0, 6)}: ${mute.reason}`);
            incr("auto_mutes_total");
          }
        }
      }
    } catch (err) {
      log.error({ err, swap }, "execution failed");
      incr("execution_errors_total");
      notify(`⚠️ execution failed for ${swap.tokenMint.slice(0, 6)}…: ${(err as Error).message}`);
    }
  });

  const stopPrice = startPriceWatcher(conn, kp);
  const stopDash = config.enableDashboard ? startDashboard(kp.publicKey) : () => {};
  const stopMetrics = startMetrics();

  if (config.autoDiscover && config.autoDiscoverRefreshMinutes > 0) {
    setInterval(async () => {
      const fresh = await resolveWallets();
      if (fresh.length !== wallets.length || fresh.some((w) => !wallets.includes(w))) {
        log.info({ before: wallets.length, after: fresh.length }, "wallet list changed — restart to apply");
        wallets = fresh;
      }
    }, config.autoDiscoverRefreshMinutes * 60_000).unref();
  }

  const shutdown = async (why: string) => {
    log.info({ why }, "shutting down");
    await stopWatcher();
    stopPrice();
    stopDash();
    stopMetrics();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  notify(
    `🚀 copy-trader started · dryRun=${config.dryRun} · following ${wallets.length}${config.jitoEnabled ? " · jito" : ""}${raceSendersReady() > 0 ? ` · ${raceSendersReady() + 1} senders` : ""}`,
  );
}

main().catch((err) => {
  log.fatal({ err }, "fatal");
  process.exit(1);
});
