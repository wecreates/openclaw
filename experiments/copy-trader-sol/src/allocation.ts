import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config.js";
import { listPositions } from "./state.js";

/**
 * Portfolio allocation gate. Prevents:
 *   - stacking too much in one mint (a leader may buy the same mint repeatedly)
 *   - overweighting one leader's picks (a single-source strategy is fragile)
 *
 * Percentages are computed against the current *invested* SOL notional, not
 * against remaining wallet balance — that would let a shrinking wallet
 * over-concentrate.
 */
export function allocationCheck(args: {
  mint: string; leader: string; sizeLamports: number;
}): { ok: boolean; reason?: string } {
  const positions = listPositions();
  const existingInvested = positions.reduce((s, p) => s + p.solSpentLamports, 0);
  // First position gets a free pass — otherwise the caps would always block.
  if (existingInvested === 0) return { ok: true };
  const totalInvested = existingInvested + args.sizeLamports;

  if (config.maxPercentPerMint > 0) {
    const inMint = positions
      .filter((p) => p.mint === args.mint)
      .reduce((s, p) => s + p.solSpentLamports, 0);
    const pct = (inMint + args.sizeLamports) / totalInvested;
    if (pct > config.maxPercentPerMint) {
      return {
        ok: false,
        reason: `mint would be ${(pct * 100).toFixed(0)}% of portfolio (cap ${(config.maxPercentPerMint * 100).toFixed(0)}%)`,
      };
    }
  }
  if (config.maxPercentPerLeader > 0) {
    const inLeader = positions
      .filter((p) => p.leader === args.leader)
      .reduce((s, p) => s + p.solSpentLamports, 0);
    const pct = (inLeader + args.sizeLamports) / totalInvested;
    if (pct > config.maxPercentPerLeader) {
      return {
        ok: false,
        reason: `leader would be ${(pct * 100).toFixed(0)}% of portfolio (cap ${(config.maxPercentPerLeader * 100).toFixed(0)}%)`,
      };
    }
  }
  return { ok: true };
}
