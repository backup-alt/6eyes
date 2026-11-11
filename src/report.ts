// 6eyes — self-contained HTML report (no external dependencies, dark theme).
// Shows: per-model budget state vs plan limits, recent routing decisions,
// context delta per turn, and a hub-graph visualization.

function esc(s: any): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string))
}

export function renderReport(x: {
  st: any
  catalog: any
  turns: any[]
  graph: any
  dir: string
  lastRoute?: any
}): string {
  const { st, catalog, turns, graph, dir, lastRoute } = x
  const rows = (catalog.models ?? [])
    .map((c: any) => {
      const u = st?.models?.[c.id] ?? {}
      const pct = u.usdLimit ? Math.min(100, (u.usd / u.usdLimit) * 100) : 0
      const used = (u.usd ?? 0).toFixed(2)
      const limit = u.usdLimit == null ? (u.free ? "free ($0)" : "unlimited") : "$" + u.usdLimit
      const bar =
        u.usdLimit == null
          ? '<div class="bar"><div class="fill free" style="width:100%"></div></div>'
          : `<div class="bar"><div class="fill ${pct > 90 ? "hot" : ""}" style="width:${pct}%"></div></div>`
      const status = (u.coolingUntil ?? 0) > Date.now() ? "cooling" : pct > 90 ? "LOW" : "ok"
      return `<tr><td class="mono">${esc(c.id)}</td><td class="num">$${used}</td><td class="num">${limit}</td><td>${bar}</td><td class="num">${u.req5h ?? 0}/${u.req5hCap ?? "∞"}</td><td>${status}</td></tr>`
    })
    .join("")

  const turnRows = (turns ?? [])
    .slice(-12)
    .reverse()
    .map((t: any) => {
      const reqs = (t.requests ?? []).map((r: any) => `${esc(r.model)} <span class="dim">(${esc(r.tier ?? r.kind ?? "")})</span>`).join(", ")
      return `<tr><td class="num">${esc((t.at ?? "").slice(11, 19))}</td><td class="num">+${t.messagesAdded ?? 0}</td><td class="mono">${reqs || '<span class="dim">—</span>'}</td></tr>`
    })
    .join("")

  const hubs: string[] = graph?.hubs ?? []
  const R = 130
  const cx = 160
  const cy = 160
  const nodes = hubs.map((h, i) => {
    const a = (i / Math.max(1, hubs.length)) * 2 * Math.PI - Math.PI / 2
    return { h, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }
  })
  const svgEdges = nodes.length > 1
    ? nodes.map((n, i) => {
        const m = nodes[(i + 1) % nodes.length]
        return `<line x1="${n.x.toFixed(0)}" y1="${n.y.toFixed(0)}" x2="${m.x.toFixed(0)}" y2="${m.y.toFixed(0)}" stroke="#30363d" stroke-width="1.5"/>`
      }).join("")
    : ""
  const svgNodes = nodes
    .map((n) => {
      const changed = (graph?.changed ?? []).includes(n.h)
      return `<circle cx="${n.x.toFixed(0)}" cy="${n.y.toFixed(0)}" r="10" fill="${changed ? "#f85149" : "#58a6ff"}"/><text x="${(n.x + 14).toFixed(0)}" y="${(n.y + 4).toFixed(0)}" font-size="10" fill="#c9d1d9">${esc(n.h.split("/").pop())}</text>`
    })
    .join("")

  const changedList = (graph?.changed ?? []).slice(0, 12).map((f: string) => `<li class="mono">${esc(f)}</li>`).join("")

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>6eyes report</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#c9d1d9; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:24px; }
  h1 { font-size:20px; color:#f0f6fc; margin:0 0 2px; }
  h2 { font-size:15px; color:#f0f6fc; margin:28px 0 8px; border-bottom:1px solid #21262d; padding-bottom:6px; }
  .dim { color:#8b949e; } .mono { font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  .sub { color:#8b949e; font-size:12px; margin-bottom:18px; }
  table { border-collapse:collapse; width:100%; }
  td, th { padding:5px 10px 5px 0; text-align:left; border-bottom:1px solid #21262d; }
  th { color:#8b949e; font-weight:600; font-size:12px; }
  .num { text-align:right; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; white-space:nowrap; }
  .bar { background:#21262d; border-radius:6px; height:8px; width:160px; min-width:120px; }
  .fill { background:#3fb950; border-radius:6px; height:8px; }
  .fill.hot { background:#d29915; } .fill.free { background:#388bfd; }
  .grid { display:flex; gap:24px; flex-wrap:wrap; align-items:flex-start; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:10px; padding:16px 20px; }
  .route { font-size:13px; }
  .pill { display:inline-block; background:#1f6feb33; border:1px solid #1f6feb; color:#79c0ff; border-radius:99px; padding:1px 10px; font-size:11.5px; margin-right:6px; }
</style></head>
<body>
<h1>👁 6eyes — context &amp; budget report</h1>
<div class="sub">${esc(dir)} · ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC · plan <b>${esc(st?.plan ?? "")}</b> · billing month ${esc(st?.month ?? "")}</div>

<h2>Routing this turn</h2>
<div class="card route">
  ${lastRoute ? `<span class="pill">${esc(lastRoute.tier)}</span><b class="mono">${esc(lastRoute.model)}</b> <span class="dim">— ${esc(lastRoute.reason)}</span>` : '<span class="dim">no routing yet (first turn)</span>'}
</div>

<h2>Plan budgets (USD estimated · requests per 5h)</h2>
<table><tr><th>model</th><th class="num">used</th><th class="num">limit</th><th></th><th class="num">5h req</th><th>status</th></tr>${rows}</table>

<h2>Context delta (recent turns)</h2>
<table><tr><th class="num">time</th><th class="num">msgs</th><th>models used</th></tr>${turnRows || '<tr><td colspan="3" class="dim">no turns recorded yet</td></tr>'}</table>

<h2>Codebase graph</h2>
<div class="grid">
  <svg width="320" height="320" viewBox="0 0 320 320">${svgEdges}${svgNodes}</svg>
  <div class="card">
    <div><b>${graph?.files ?? 0}</b> files · <b>${graph?.edges ?? 0}</b> import edges ${graph?.truncated ? '<span class="dim">(truncated)</span>' : ""}</div>
    <div class="dim" style="margin-top:6px">hubs (most imported):</div>
    <ul class="mono" style="margin:4px 0 0 18px;padding:0">${(hubs ?? []).slice(0, 8).map((h: string) => `<li>${esc(h)}</li>`).join("")}</ul>
    ${changedList ? `<div class="dim" style="margin-top:10px">new since last report:</div><ul class="mono" style="margin:4px 0 0 18px;padding:0">${changedList}</ul>` : ""}
  </div>
</div>
</body></html>`
}
