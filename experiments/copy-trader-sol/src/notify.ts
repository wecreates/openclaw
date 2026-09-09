import { request } from "undici";
import { config } from "./config.js";
import { log } from "./log.js";

let queue: Promise<void> = Promise.resolve();

export function notify(msg: string): void {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  queue = queue.then(async () => {
    try {
      await request(
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
        },
      );
    } catch (err) {
      log.warn({ err }, "telegram notify failed");
    }
  });
}

export function fmtSol(lamports: number): string {
  return (lamports / 1e9).toFixed(4);
}
