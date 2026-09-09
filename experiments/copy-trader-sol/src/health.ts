import { killSwitchTripped } from "./risk.js";
import { countPositions } from "./state.js";
import { queueDepth } from "./sellqueue.js";
import { config } from "./config.js";

let lastLeaderSwapAt = 0;
let lastPriceCheckAt = 0;
let startedAt = Date.now();

export function markLeaderSwap(): void { lastLeaderSwapAt = Date.now(); }
export function markPriceCheck(): void { lastPriceCheckAt = Date.now(); }

/**
 * Kubernetes-friendly health. `ok` if we booted, no kill switch is set, and
 * (when positions are open) the price watcher ticked in the last 5 min.
 * `degraded` otherwise; still 200 unless critical.
 */
export function getHealth(): {
  status: "ok" | "degraded" | "down";
  uptimeSec: number;
  dryRun: boolean;
  killSwitch: boolean;
  openPositions: number;
  sellQueueDepth: number;
  lastLeaderSwapAgoSec: number | null;
  lastPriceCheckAgoSec: number | null;
} {
  const kill = killSwitchTripped();
  const open = countPositions();
  const queue = queueDepth();
  const now = Date.now();
  const priceAgo = lastPriceCheckAt ? (now - lastPriceCheckAt) / 1000 : null;
  const leaderAgo = lastLeaderSwapAt ? (now - lastLeaderSwapAt) / 1000 : null;

  const priceStale = open > 0 && (priceAgo === null || priceAgo > 300);
  const status: "ok" | "degraded" | "down" = kill
    ? "degraded"
    : priceStale
      ? "degraded"
      : "ok";

  return {
    status,
    uptimeSec: Math.floor((now - startedAt) / 1000),
    dryRun: config.dryRun,
    killSwitch: kill,
    openPositions: open,
    sellQueueDepth: queue,
    lastLeaderSwapAgoSec: leaderAgo,
    lastPriceCheckAgoSec: priceAgo,
  };
}
