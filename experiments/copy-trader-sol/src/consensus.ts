import { config } from "./config.js";

type Signal = {
  leader: string;
  seenAt: number;
};

const buyIntents = new Map<string, Signal[]>();

/**
 * Track buy intents per mint over a rolling window. Returns whether the
 * current tick meets the CONSENSUS_MIN_LEADERS threshold within the last
 * CONSENSUS_WINDOW_SEC seconds.
 *
 * Called once per leader-buy that survives the earlier gates. When the
 * threshold is 1 the check is a no-op — most single-leader setups.
 */
export function registerBuyIntent(mint: string, leader: string): {
  cleared: boolean;
  leaders: string[];
} {
  const now = Date.now();
  const windowMs = config.consensusWindowSec * 1000;
  const arr = buyIntents.get(mint) ?? [];
  const kept = arr.filter((s) => now - s.seenAt <= windowMs && s.leader !== leader);
  kept.push({ leader, seenAt: now });
  buyIntents.set(mint, kept);

  const unique = new Set(kept.map((s) => s.leader));
  const cleared = unique.size >= config.consensusMinLeaders;
  return { cleared, leaders: [...unique] };
}

export function _resetConsensusForTest(): void {
  buyIntents.clear();
}
