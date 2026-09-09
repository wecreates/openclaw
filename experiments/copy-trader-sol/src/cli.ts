import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  listPositions,
  listRecentTrades,
  pnlLast24hLamports,
  totalPnlLamports,
} from "./state.js";
import {
  leaderStats,
  listMutes,
  muteLeader,
  unmuteLeader,
} from "./scoring.js";
import { exportTradesCsv } from "./export.js";
import { perHourOfDay, perLeader, perMint } from "./analytics.js";
import { buyQueueDepth } from "./buyqueue.js";
import { queueDepth as sellQueueDepth } from "./sellqueue.js";

const cmd = process.argv[2] ?? "status";
const args = process.argv.slice(3);

const fmt = (l: number): string =>
  `${l >= 0 ? "+" : ""}${(l / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const short = (s: string): string => `${s.slice(0, 6)}…${s.slice(-4)}`;
const table = (rows: string[][]): string => {
  if (rows.length === 0) return "(none)";
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  return rows
    .map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  "))
    .join("\n");
};

async function main(): Promise<void> {
  switch (cmd) {
    case "status": {
      const positions = listPositions();
      console.log(`open positions: ${positions.length}`);
      console.log(`PnL 24h:  ${fmt(pnlLast24hLamports())}`);
      console.log(`PnL all:  ${fmt(totalPnlLamports())}`);
      console.log(`buy queue:  ${buyQueueDepth()}`);
      console.log(`sell queue: ${sellQueueDepth()}`);
      break;
    }
    case "positions": {
      const rows: string[][] = [["MINT", "LEADER", "SPENT", "VALUE", "PNL", "%"]];
      for (const p of listPositions()) {
        const amount = Number(BigInt(p.amountRaw));
        const value = p.lastPriceSolPerToken * amount;
        const pnlL = value - p.solSpentLamports;
        const pnlPct = p.entryPriceSolPerToken > 0
          ? (p.lastPriceSolPerToken / p.entryPriceSolPerToken - 1) * 100 : 0;
        rows.push([
          short(p.mint), short(p.leader),
          fmt(p.solSpentLamports).replace(" SOL", ""),
          fmt(value).replace(" SOL", ""),
          fmt(pnlL).replace(" SOL", ""),
          `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`,
        ]);
      }
      console.log(table(rows)); break;
    }
    case "trades": {
      const rows: string[][] = [["TIME", "SIDE", "MINT", "LEADER", "ΔSOL", "REASON"]];
      for (const t of listRecentTrades(50)) {
        rows.push([
          new Date(t.createdAt).toISOString().replace("T", " ").slice(0, 19),
          t.side, short(t.mint), short(t.leader),
          fmt(t.solDeltaLamports).replace(" SOL", ""),
          t.reason ?? "",
        ]);
      }
      console.log(table(rows)); break;
    }
    case "leaders": {
      const rows: string[][] = [["LEADER", "TRADES", "WIN%", "NET"]];
      for (const s of leaderStats()) {
        rows.push([
          short(s.leader), String(s.trades),
          `${(s.winRate * 100).toFixed(0)}%`, fmt(s.netLamports),
        ]);
      }
      console.log(table(rows)); break;
    }
    case "mute": {
      const [leader, ...rest] = args;
      if (!leader) throw new Error("usage: pnpm cli mute <leader> [reason]");
      muteLeader(leader, rest.join(" ") || "manual");
      console.log(`muted ${leader}`); break;
    }
    case "unmute": {
      const [leader] = args;
      if (!leader) throw new Error("usage: pnpm cli unmute <leader>");
      unmuteLeader(leader);
      console.log(`unmuted ${leader}`); break;
    }
    case "mutes": {
      const rows: string[][] = [["LEADER", "MUTED AT", "REASON"]];
      for (const m of listMutes()) {
        rows.push([
          short(m.leader),
          new Date(m.mutedAt).toISOString().replace("T", " ").slice(0, 19),
          m.reason ?? "",
        ]);
      }
      console.log(table(rows)); break;
    }
    case "export": {
      const path = args[0] ?? "./data/trades.csv";
      const n = exportTradesCsv(path);
      console.log(`wrote ${n} trades to ${path}`);
      break;
    }
    case "analyze": {
      const scope = args[0] ?? "leaders";
      const rows: string[][] = [["KEY", "TRADES", "WIN%", "NET"]];
      const data =
        scope === "mints" ? perMint()
        : scope === "hours" ? perHourOfDay()
        : perLeader();
      for (const s of data) {
        rows.push([
          scope === "hours" ? s.key : short(s.key),
          String(s.trades),
          `${(s.winRate * 100).toFixed(0)}%`,
          fmt(s.netLamports),
        ]);
      }
      console.log(table(rows));
      break;
    }
    default:
      console.log([
        "Commands:",
        "  pnpm cli status",
        "  pnpm cli positions",
        "  pnpm cli trades",
        "  pnpm cli leaders",
        "  pnpm cli mute <leader> [reason]",
        "  pnpm cli unmute <leader>",
        "  pnpm cli mutes",
        "  pnpm cli export [path.csv]",
        "  pnpm cli analyze [leaders|mints|hours]",
      ].join("\n"));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
