import { fetchJson } from "./http.js";
import { config } from "./config.js";
import { discordNotify } from "./discord.js";
import { log } from "./log.js";

let queue: Promise<void> = Promise.resolve();

/**
 * Fan out one message to every configured channel (Telegram + Discord).
 * Serialized so a slow channel never blocks execution.
 */
export function notify(msg: string): void {
  discordNotify(msg);
  if (!config.telegramBotToken || !config.telegramChatId) return;
  queue = queue.then(async () => {
    try {
      await fetchJson<{}>(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: config.telegramChatId,
            text: msg,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
          retries: 1,
          timeoutMs: 4000,
        },
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, "telegram notify failed");
    }
  });
}

export function fmtSol(lamports: number): string {
  return (lamports / 1e9).toFixed(4);
}
