import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { existsSync } from "node:fs";
import { request } from "undici";
import { SOL_MINT, USDC_MINT, config } from "./config.js";
import { log } from "./log.js";

export type PreflightResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export async function runPreflight(
  conn: Connection,
  walletPubkey: PublicKey,
): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const slot = await conn.getSlot("confirmed");
    log.info({ slot }, "rpc reachable");
  } catch (err) {
    errors.push(`RPC unreachable at ${config.rpcUrl}: ${(err as Error).message}`);
  }

  let solLamports = 0;
  try {
    solLamports = await conn.getBalance(walletPubkey, "confirmed");
    const sol = solLamports / LAMPORTS_PER_SOL;
    log.info({ sol, wallet: walletPubkey.toBase58() }, "wallet balance");
    if (solLamports === 0) {
      errors.push(`Trading wallet ${walletPubkey.toBase58()} has 0 SOL. Fund it before running live.`);
    } else if (config.fixedBuySol > 0 && sol < config.fixedBuySol * 2) {
      warnings.push(
        `Wallet has ${sol.toFixed(4)} SOL but FIXED_BUY_SOL=${config.fixedBuySol}. You can afford <2 trades.`,
      );
    }
  } catch (err) {
    errors.push(`Balance check failed: ${(err as Error).message}`);
  }

  try {
    const url = new URL("https://quote-api.jup.ag/v6/quote");
    url.searchParams.set("inputMint", SOL_MINT);
    url.searchParams.set("outputMint", USDC_MINT);
    url.searchParams.set("amount", String(Math.floor(0.01 * LAMPORTS_PER_SOL)));
    url.searchParams.set("slippageBps", "150");
    const res = await request(url.toString());
    if (res.statusCode !== 200) {
      errors.push(`Jupiter quote endpoint returned ${res.statusCode}`);
    } else {
      log.info("jupiter reachable");
    }
  } catch (err) {
    errors.push(`Jupiter unreachable: ${(err as Error).message}`);
  }

  for (const w of config.followedWallets) {
    try {
      new PublicKey(w);
    } catch {
      errors.push(`Invalid followed wallet: ${w}`);
    }
  }
  if (config.followedWallets.length === 0 && !config.autoDiscover) {
    errors.push("No followed wallets. Set FOLLOWED_WALLETS or enable AUTO_DISCOVER=1.");
  }

  if (config.fixedBuySol <= 0 && config.leaderPercent <= 0) {
    errors.push("No sizing configured. Set FIXED_BUY_SOL or LEADER_PERCENT.");
  }
  if (config.fixedBuySol > 0 && config.leaderPercent > 0) {
    warnings.push("Both FIXED_BUY_SOL and LEADER_PERCENT set. Fixed wins.");
  }

  if (existsSync(config.killSwitchPath)) {
    warnings.push(`Kill switch present at ${config.killSwitchPath}. Bot will not trade until removed.`);
  }

  if (!config.dryRun) {
    warnings.push("DRY_RUN=0 — this run will send real transactions.");
  }

  return { ok: errors.length === 0, errors, warnings };
}
