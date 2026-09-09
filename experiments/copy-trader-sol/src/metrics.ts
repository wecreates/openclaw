import { createServer, type Server } from "node:http";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config.js";
import {
  countPositions,
  listPositions,
  listRecentTrades,
  pnlLast24hLamports,
  totalPnlLamports,
} from "./state.js";
import { listMutes } from "./scoring.js";
import { log } from "./log.js";

const counters = new Map<string, number>();
export function incr(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/**
 * A tiny /metrics endpoint in Prometheus text format. No external dep — the
 * whole surface is a handful of counters plus DB-derived gauges.
 */
export function startMetrics(): () => void {
  if (!config.enableMetrics) return () => {};

  const server: Server = createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404); res.end(); return;
    }
    const positions = listPositions();
    const openValueLamports = positions.reduce((sum, p) => {
      const amount = Number(BigInt(p.amountRaw));
      return sum + p.lastPriceSolPerToken * amount;
    }, 0);
    const trades24h = listRecentTrades(1000).filter(
      (t) => Date.now() - t.createdAt < 24 * 60 * 60 * 1000,
    );

    const lines = [
      `# HELP copytrader_open_positions Current count of open positions`,
      `# TYPE copytrader_open_positions gauge`,
      `copytrader_open_positions ${countPositions()}`,
      ``,
      `# HELP copytrader_open_value_sol Current SOL value of all open positions`,
      `# TYPE copytrader_open_value_sol gauge`,
      `copytrader_open_value_sol ${(openValueLamports / LAMPORTS_PER_SOL).toFixed(6)}`,
      ``,
      `# HELP copytrader_pnl_24h_sol Realized PnL in last 24h (SOL)`,
      `# TYPE copytrader_pnl_24h_sol gauge`,
      `copytrader_pnl_24h_sol ${(pnlLast24hLamports() / LAMPORTS_PER_SOL).toFixed(6)}`,
      ``,
      `# HELP copytrader_pnl_alltime_sol Realized PnL all-time (SOL)`,
      `# TYPE copytrader_pnl_alltime_sol gauge`,
      `copytrader_pnl_alltime_sol ${(totalPnlLamports() / LAMPORTS_PER_SOL).toFixed(6)}`,
      ``,
      `# HELP copytrader_trades_24h_total Trade count in last 24h by side`,
      `# TYPE copytrader_trades_24h_total counter`,
      `copytrader_trades_24h_total{side="buy"} ${trades24h.filter((t) => t.side === "buy").length}`,
      `copytrader_trades_24h_total{side="sell"} ${trades24h.filter((t) => t.side === "sell").length}`,
      ``,
      `# HELP copytrader_muted_leaders Leaders currently auto-muted`,
      `# TYPE copytrader_muted_leaders gauge`,
      `copytrader_muted_leaders ${listMutes().length}`,
      ``,
      `# HELP copytrader_dryrun Whether the bot is in dry-run mode`,
      `# TYPE copytrader_dryrun gauge`,
      `copytrader_dryrun ${config.dryRun ? 1 : 0}`,
      ``,
    ];

    for (const [name, val] of counters) {
      lines.push(
        `# HELP copytrader_${name} Bot event counter`,
        `# TYPE copytrader_${name} counter`,
        `copytrader_${name} ${val}`,
        ``,
      );
    }

    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(lines.join("\n"));
  });
  server.listen(config.metricsPort, "127.0.0.1", () => {
    log.info({ url: `http://127.0.0.1:${config.metricsPort}/metrics` }, "metrics up");
  });
  return () => server.close();
}
