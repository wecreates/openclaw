import { fetchJson } from "./http.js";

const QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const SWAP_URL = "https://quote-api.jup.ag/v6/swap";

export type QuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  priceImpactPct: string;
  routePlan: unknown[];
};

export async function quote(args: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}): Promise<QuoteResponse> {
  const url = new URL(QUOTE_URL);
  url.searchParams.set("inputMint", args.inputMint);
  url.searchParams.set("outputMint", args.outputMint);
  url.searchParams.set("amount", args.amount.toString());
  url.searchParams.set("slippageBps", String(args.slippageBps));
  url.searchParams.set("swapMode", "ExactIn");
  url.searchParams.set("onlyDirectRoutes", "false");
  url.searchParams.set("asLegacyTransaction", "false");
  return fetchJson<QuoteResponse>(url.toString(), { retries: 3, timeoutMs: 6000 });
}

export async function buildSwapTx(args: {
  quote: QuoteResponse;
  userPublicKey: string;
  priorityFeeMicrolamports: number;
}): Promise<string> {
  const body = {
    quoteResponse: args.quote,
    userPublicKey: args.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: args.priorityFeeMicrolamports * 1000,
        priorityLevel: "high",
      },
    },
  };
  const j = await fetchJson<{ swapTransaction: string }>(SWAP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    retries: 2,
    timeoutMs: 10000,
  });
  return j.swapTransaction;
}
