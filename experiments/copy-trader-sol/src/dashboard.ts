import { createServer } from "node:http";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import {
  listPositions,
  listRecentTrades,
  pnlLast24hLamports,
  totalPnlLamports,
} from "./state.js";
import { killSwitchTripped } from "./risk.js";
import { listMutes } from "./scoring.js";
import { solUsd } from "./solprice.js";
import { log } from "./log.js";

export function startDashboard(walletPubkey: PublicKey): () => void {
  const server = createServer(async (req, res) => {
    if (req.url === "/api/status") {
      const body = JSON.stringify(await snapshot(walletPubkey));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body); return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderPage(walletPubkey));
  });
  server.listen(config.dashboardPort, "127.0.0.1", () => {
    log.info({ url: `http://127.0.0.1:${config.dashboardPort}` }, "dashboard up");
  });
  return () => server.close();
}

async function snapshot(walletPubkey: PublicKey) {
  const usd = await solUsd();
  const positions = listPositions().map((p) => {
    const amount = Number(BigInt(p.amountRaw));
    const nowValue = p.lastPriceSolPerToken * amount;
    const pnlL = nowValue - p.solSpentLamports;
    const pnlPct = p.entryPriceSolPerToken > 0
      ? (p.lastPriceSolPerToken / p.entryPriceSolPerToken - 1) * 100 : 0;
    return {
      mint: p.mint, leader: p.leader,
      spentSol: p.solSpentLamports / LAMPORTS_PER_SOL,
      valueSol: nowValue / LAMPORTS_PER_SOL,
      pnlSol: pnlL / LAMPORTS_PER_SOL,
      pnlPct, openedAt: p.openedAt,
    };
  });
  return {
    wallet: walletPubkey.toBase58(),
    dryRun: config.dryRun,
    killSwitch: killSwitchTripped(),
    followed: config.followedWallets,
    muted: listMutes().length,
    solUsd: usd,
    limits: {
      maxPositions: config.maxConcurrentPositions,
      dailyLossSol: config.dailyLossLimitSol,
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      trailingStopPct: config.trailingStopPct,
      consensusMinLeaders: config.consensusMinLeaders,
      jitoEnabled: config.jitoEnabled,
    },
    pnl24hSol: pnlLast24hLamports() / LAMPORTS_PER_SOL,
    pnlAllTimeSol: totalPnlLamports() / LAMPORTS_PER_SOL,
    positions,
    recentTrades: listRecentTrades(30).map((t) => ({
      ...t, solDelta: t.solDeltaLamports / LAMPORTS_PER_SOL,
    })),
  };
}

function renderPage(walletPubkey: PublicKey): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>copy-trader ${walletPubkey.toBase58().slice(0, 6)}</title>
<meta http-equiv="refresh" content="5"/>
<style>
  :root { color-scheme: dark light; }
  body { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 20px; max-width: 1200px; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 12px 0; }
  .card { border: 1px solid #8886; padding: 10px 12px; border-radius: 6px; }
  .card .k { opacity: 0.65; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .v { font-size: 17px; margin-top: 4px; }
  .card .sub { font-size: 11px; opacity: 0.6; margin-top: 2px; }
  .pos { color: mediumseagreen; } .neg { color: crimson; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8883; font-variant-numeric: tabular-nums; }
  th { opacity: 0.7; font-weight: 600; }
  tr td:first-child { font-family: ui-monospace, monospace; }
  .flag { display: inline-block; padding: 2px 6px; border-radius: 3px; margin-left: 6px; font-size: 11px; }
  .dry { background: #f6c85f; color: #222; }
  .kill { background: crimson; color: white; }
  .jito { background: #6366f1; color: white; }
  .muted { opacity: 0.5; }
</style>
</head><body>
<h1>copy-trader <span class="muted">${walletPubkey.toBase58()}</span></h1>
<div id="app">loading…</div>
<script>
async function refresh() {
  const s = await (await fetch('/api/status')).json();
  const fmt = (n) => (n>=0?'+':'') + n.toFixed(4);
  const pct = (n) => (n>=0?'+':'') + n.toFixed(1) + '%';
  const usd = (n) => s.solUsd ? '$' + (n * s.solUsd).toFixed(2) : '';
  const cls = (n) => n >= 0 ? 'pos' : 'neg';
  const flags =
    (s.dryRun ? '<span class="flag dry">DRY_RUN</span>' : '') +
    (s.killSwitch ? '<span class="flag kill">KILL SWITCH</span>' : '') +
    (s.limits.jitoEnabled ? '<span class="flag jito">JITO</span>' : '');
  document.getElementById('app').innerHTML = \`
    <div>\${flags} following \${s.followed.length} · \${s.muted} muted · consensus \${s.limits.consensusMinLeaders} · stop \${(s.limits.stopLossPct*100).toFixed(0)}% · trail \${(s.limits.trailingStopPct*100).toFixed(0)}% after +\${(s.limits.takeProfitPct*100).toFixed(0)}% · SOL \${s.solUsd ? '$'+s.solUsd.toFixed(2) : '—'}</div>
    <div class="grid">
      <div class="card"><div class="k">PnL 24h</div><div class="v \${cls(s.pnl24hSol)}">\${fmt(s.pnl24hSol)} SOL</div><div class="sub">\${usd(s.pnl24hSol)}</div></div>
      <div class="card"><div class="k">PnL all-time</div><div class="v \${cls(s.pnlAllTimeSol)}">\${fmt(s.pnlAllTimeSol)} SOL</div><div class="sub">\${usd(s.pnlAllTimeSol)}</div></div>
      <div class="card"><div class="k">Open positions</div><div class="v">\${s.positions.length} / \${s.limits.maxPositions}</div></div>
      <div class="card"><div class="k">Daily loss cap</div><div class="v">\${s.limits.dailyLossSol} SOL</div></div>
      <div class="card"><div class="k">Muted leaders</div><div class="v">\${s.muted}</div></div>
    </div>
    <h3>Positions</h3>
    <table><thead><tr><th>Mint</th><th>Leader</th><th>Spent</th><th>Value</th><th>PnL</th><th>%</th><th>USD</th><th>Opened</th></tr></thead>
    <tbody>\${s.positions.map(p => \`
      <tr>
        <td>\${p.mint.slice(0,8)}…</td>
        <td class="muted">\${p.leader.slice(0,6)}…</td>
        <td>\${p.spentSol.toFixed(4)}</td>
        <td>\${p.valueSol.toFixed(4)}</td>
        <td class="\${cls(p.pnlSol)}">\${fmt(p.pnlSol)}</td>
        <td class="\${cls(p.pnlPct)}">\${pct(p.pnlPct)}</td>
        <td class="\${cls(p.pnlSol)}">\${usd(p.pnlSol)}</td>
        <td class="muted">\${new Date(p.openedAt).toLocaleTimeString()}</td>
      </tr>\`).join('') || '<tr><td colspan="8" class="muted">no open positions</td></tr>'}</tbody></table>
    <h3>Recent trades</h3>
    <table><thead><tr><th>Time</th><th>Side</th><th>Mint</th><th>Leader</th><th>SOL Δ</th><th>USD Δ</th><th>Reason</th></tr></thead>
    <tbody>\${s.recentTrades.map(t => \`
      <tr>
        <td class="muted">\${new Date(t.createdAt).toLocaleTimeString()}</td>
        <td>\${t.side}</td>
        <td>\${t.mint.slice(0,8)}…</td>
        <td class="muted">\${t.leader.slice(0,6)}…</td>
        <td class="\${cls(t.solDelta)}">\${fmt(t.solDelta)}</td>
        <td class="\${cls(t.solDelta)}">\${usd(t.solDelta)}</td>
        <td class="muted">\${t.reason ?? ''}</td>
      </tr>\`).join('') || '<tr><td colspan="7" class="muted">no trades yet</td></tr>'}</tbody></table>\`;
}
refresh(); setInterval(refresh, 5000);
</script>
</body></html>`;
}
