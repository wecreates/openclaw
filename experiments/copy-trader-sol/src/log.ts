import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import { config } from "./config.js";

function todaysLogPath(base: string): string {
  const day = new Date().toISOString().slice(0, 10);
  // Insert day before the extension: ./data/logs/bot.log → ./data/logs/bot.2026-09-09.log
  const dot = base.lastIndexOf(".");
  if (dot < 0) return `${base}.${day}`;
  return `${base.slice(0, dot)}.${day}${base.slice(dot)}`;
}

const targets: pino.TransportTargetOptions[] = [
  {
    target: "pino-pretty",
    level: config.logLevel,
    options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
  },
];

if (config.logFile) {
  const path = todaysLogPath(config.logFile);
  mkdirSync(dirname(path), { recursive: true });
  targets.push({
    target: "pino/file",
    level: config.logLevel,
    options: { destination: path, mkdir: true, sync: false },
  });
}

export const log = pino({
  level: config.logLevel,
  transport: { targets },
});
