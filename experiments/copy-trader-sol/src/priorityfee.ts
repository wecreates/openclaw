import { fetchJson } from "./http.js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Ask Helius's `getPriorityFeeEstimate` RPC method what the current network
 * priority-fee percentile looks like. We use the "high" level: fee likely to
 * land in ~1 slot for the mentioned accounts. Falls back to the static
 * PRIORITY_FEE_MICROLAMPORTS on any error so a bad estimator doesn't
 * hard-stop trading.
 *
 * Helius docs: https://docs.helius.dev/solana-apis/priority-fee-api
 */
type EstimateResp = {
  result?: {
    priorityFeeEstimate?: number;
    priorityFeeLevels?: {
      min?: number; low?: number; medium?: number; high?: number;
      veryHigh?: number; unsafeMax?: number;
    };
  };
  error?: { message?: string };
};

let cached: { microLamports: number; at: number } | null = null;
const TTL_MS = 3_000;

export async function dynamicPriorityFee(fallback: number): Promise<number> {
  if (!config.priorityFeeDynamic) return fallback;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.microLamports;

  try {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getPriorityFeeEstimate",
      params: [{ options: { includeAllPriorityFeeLevels: true, priorityLevel: "High" } }],
    };
    const res = await fetchJson<EstimateResp>(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      retries: 1,
      timeoutMs: 3000,
    });
    if (res.error) throw new Error(res.error.message ?? "estimate error");
    const level = res.result?.priorityFeeLevels?.high;
    const single = res.result?.priorityFeeEstimate;
    const raw = Math.max(level ?? 0, single ?? 0, fallback);
    const capped = Math.min(raw, config.priorityFeeMicrolamportsMax);
    cached = { microLamports: capped, at: Date.now() };
    return capped;
  } catch (err) {
    log.debug({ err: (err as Error).message }, "priority fee estimator failed; using fallback");
    return fallback;
  }
}
