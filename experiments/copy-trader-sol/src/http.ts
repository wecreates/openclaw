import { request } from "undici";
import { log } from "./log.js";

export type FetchOpts = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  retryOn?: (statusCode: number) => boolean;
};

class NonRetryable extends Error {}

/**
 * Retrying JSON request with exponential backoff.
 * Retries 5xx, 408, 429, and network errors. Never retries other 4xx.
 */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retryOn = opts.retryOn ??
    ((s) => s === 408 || s === 429 || (s >= 500 && s < 600));

  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await request(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return (await res.body.json()) as T;
      }
      const text = await res.body.text().catch(() => "");
      const msg = `HTTP ${res.statusCode} ${url}: ${text.slice(0, 200)}`;
      if (!retryOn(res.statusCode)) throw new NonRetryable(msg);
      if (attempt === retries) throw new Error(msg);
      log.debug({ status: res.statusCode, attempt, url }, "retrying");
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof NonRetryable) throw err;
      lastErr = err;
      if (attempt === retries) throw err;
    }
    const delay = Math.min(4000, 200 * 2 ** attempt) + Math.random() * 200;
    await new Promise((r) => setTimeout(r, delay));
    attempt++;
  }
  throw lastErr instanceof Error ? lastErr : new Error("retry exhausted");
}
