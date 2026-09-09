import { notify as rawNotify } from "./notify.js";
import { config } from "./config.js";
import { incr } from "./metrics.js";

type Bucket = { firstAt: number; count: number };
const buckets = new Map<string, Bucket>();

/**
 * Wrap notify() to collapse repeat alerts. Same `key` fires immediately on
 * the first hit; subsequent hits within the window are suppressed but
 * counted. A summary line is emitted when the window closes.
 *
 * Use for high-cardinality alerts (rug skips, throttled RPC errors) — not
 * for one-shot events like a trade landing.
 */
export function notifyDedup(key: string, msg: string): void {
  const windowMs = config.alertDedupWindowSec * 1000;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.firstAt > windowMs) {
    if (b && b.count > 1) {
      rawNotify(`(and ${b.count - 1} more ${key} in the last ${config.alertDedupWindowSec}s)`);
    }
    buckets.set(key, { firstAt: now, count: 1 });
    rawNotify(msg);
    return;
  }
  b.count++;
  incr("alerts_suppressed_total");
}

export function _resetAlertsForTest(): void {
  buckets.clear();
}
