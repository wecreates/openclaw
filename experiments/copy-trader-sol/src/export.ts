import { writeFileSync } from "node:fs";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { listRecentTrades } from "./state.js";

function csvEscape(s: string): string {
  if (/["\n,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportTradesCsv(path: string, limit = 100_000): number {
  const rows = listRecentTrades(limit);
  const header = ["id", "time_iso", "side", "mint", "leader", "sol_delta", "tx_sig", "reason"].join(",");
  const body = rows.map((t) =>
    [
      t.id,
      new Date(t.createdAt).toISOString(),
      t.side,
      t.mint,
      t.leader,
      (t.solDeltaLamports / LAMPORTS_PER_SOL).toFixed(9),
      t.txSig ?? "",
      csvEscape(t.reason ?? ""),
    ].join(","),
  );
  writeFileSync(path, [header, ...body].join("\n"));
  return rows.length;
}
