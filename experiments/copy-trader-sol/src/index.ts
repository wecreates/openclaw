import { Connection } from "@solana/web3.js";
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
} from "./state.js";
import {
  dailyLossExceeded,
  isBlacklisted,
  passesLiquidity,
  sizeBuyLamports,
} from "./risk.js";

async function main() {
  if (config.followedWallets.length === 0) {
    throw new Error("FOLLOWED_WALLETS is empty — add at least one wallet address to .env");
  }

  const kp = loadKeypair();
  const conn = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: config.wsUrl,
  });

  log.info(
    {
      wallet: kp.publicKey.toBase58(),
      followed: config.followedWallets.length,
      dryRun: config.dryRun,
    },
    "starting copy-trader",
  );

  const stop = watchWallets(conn, [...config.followedWallets], async (swap) => {
    if (dailyLossExceeded()) {
      log.warn("skipping: daily loss limit hit");
      return;
    }
    if (isBlacklisted(swap.tokenMint)) {
      log.info({ mint: swap.tokenMint }, "skipping: blacklisted");
      return;
    }

    try {
      if (swap.side === "buy") {
        if (!(await passesLiquidity(swap.tokenMint))) {
          log.info({ mint: swap.tokenMint }, "skipping: illiquid");
          return;
        }
        const size = sizeBuyLamports(swap.solLamports);
        if (size <= 0) {
          log.warn("skipping: no sizing configured (set FIXED_BUY_SOL or LEADER_PERCENT)");
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
        });
        recordTrade({
          side: "buy",
          mint: swap.tokenMint,
          leader: swap.leader,
          solDeltaLamports: -res.solLamports,
          txSig: res.signature,
        });
      } else {
        const pos = getPosition(swap.tokenMint, swap.leader);
        if (!pos) {
          log.info(
            { mint: swap.tokenMint, leader: swap.leader },
            "leader sold a token we don't hold from them — skipping",
          );
          return;
        }
        const res = await sell(conn, kp, swap.tokenMint, BigInt(pos.amountRaw));
        closePosition(swap.tokenMint, swap.leader);
        recordTrade({
          side: "sell",
          mint: swap.tokenMint,
          leader: swap.leader,
          solDeltaLamports: res.solLamports - pos.solSpentLamports,
          txSig: res.signature,
        });
      }
    } catch (err) {
      log.error({ err, swap }, "execution failed");
    }
  });

  const shutdown = async (why: string) => {
    log.info({ why }, "shutting down");
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "fatal");
  process.exit(1);
});
