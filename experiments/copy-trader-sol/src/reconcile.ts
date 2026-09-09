import { Connection, PublicKey } from "@solana/web3.js";
import { closePosition, listPositions, updatePositionAmount } from "./state.js";
import { log } from "./log.js";

/**
 * Walk every open position in the DB and reconcile against the on-chain balance
 * of the trading wallet. If a position's token was moved or fully sold outside
 * the bot (manual sale, wallet drain, RPC-missed sell), correct or drop it so
 * the price watcher isn't polling a phantom.
 */
export async function reconcilePositions(
  conn: Connection,
  walletPubkey: PublicKey,
): Promise<{ kept: number; adjusted: number; closed: number }> {
  const positions = listPositions();
  if (positions.length === 0) return { kept: 0, adjusted: 0, closed: 0 };

  const accounts = await conn.getParsedTokenAccountsByOwner(
    walletPubkey,
    { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
    "confirmed",
  );
  const onChain = new Map<string, bigint>();
  for (const a of accounts.value) {
    const info = a.account.data.parsed?.info;
    if (!info) continue;
    const mint = info.mint as string;
    const raw = BigInt(info.tokenAmount?.amount ?? "0");
    onChain.set(mint, (onChain.get(mint) ?? 0n) + raw);
  }

  let kept = 0, adjusted = 0, closed = 0;
  for (const p of positions) {
    const held = onChain.get(p.mint) ?? 0n;
    const dbAmount = BigInt(p.amountRaw);
    if (held === 0n) {
      log.warn(
        { mint: p.mint, leader: p.leader, dbAmount: p.amountRaw },
        "reconcile: position not held on-chain — closing",
      );
      closePosition(p.mint, p.leader);
      closed++;
    } else if (held !== dbAmount) {
      const ratio = Number(held) / Number(dbAmount);
      const newCost = Math.floor(p.solSpentLamports * Math.min(1, ratio));
      log.warn(
        { mint: p.mint, dbAmount: p.amountRaw, onChain: held.toString(), ratio },
        "reconcile: on-chain amount differs — adjusting",
      );
      updatePositionAmount(p.mint, p.leader, held.toString(), newCost);
      adjusted++;
    } else {
      kept++;
    }
  }
  log.info({ kept, adjusted, closed }, "reconcile complete");
  return { kept, adjusted, closed };
}
