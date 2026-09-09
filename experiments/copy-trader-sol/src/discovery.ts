import { request } from "undici";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Fetch top Solana wallets by short-window PnL from GMGN's public rank endpoint.
 * The endpoint's shape can shift without notice; failures fall back to whatever
 * FOLLOWED_WALLETS the user configured statically.
 */
export async function fetchTopWallets(count: number): Promise<string[]> {
  try {
    const url = new URL(
      "https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d",
    );
    url.searchParams.set("tag", "smart_degen");
    url.searchParams.set("orderby", "pnl_7d");
    url.searchParams.set("direction", "desc");

    const res = await request(url.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        accept: "application/json",
      },
    });
    if (res.statusCode !== 200) {
      log.warn({ status: res.statusCode }, "gmgn returned non-200; using static followed list");
      return [];
    }
    const body = (await res.body.json()) as {
      data?: { rank?: { wallet_address?: string; winrate?: number }[] };
    };
    const rows = body.data?.rank ?? [];
    const picks: string[] = [];
    for (const row of rows) {
      const addr = row.wallet_address;
      if (!addr) continue;
      try {
        new PublicKey(addr);
      } catch {
        continue;
      }
      if ((row.winrate ?? 0) < 0.55) continue;
      picks.push(addr);
      if (picks.length >= count) break;
    }
    log.info({ count: picks.length }, "gmgn top wallets");
    return picks;
  } catch (err) {
    log.warn({ err }, "gmgn discovery failed");
    return [];
  }
}

export async function resolveWallets(): Promise<string[]> {
  const seed = [...config.followedWallets];
  if (!config.autoDiscover) return seed;

  const discovered = await fetchTopWallets(config.autoDiscoverCount);
  const merged = new Set([...seed, ...discovered]);
  return [...merged];
}
