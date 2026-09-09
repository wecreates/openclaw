import { fetchJson } from "./http.js";
import { config } from "./config.js";
import { log } from "./log.js";

let queue: Promise<void> = Promise.resolve();

/** POST a message to a Discord webhook. No-op when unset. Fire and forget. */
export function discordNotify(msg: string): void {
  if (!config.discordWebhookUrl) return;
  queue = queue.then(async () => {
    try {
      await fetchJson<{}>(config.discordWebhookUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: msg.slice(0, 1900) }),
        retries: 1,
        timeoutMs: 4000,
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "discord notify failed");
    }
  });
}
