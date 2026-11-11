// 6eyes — Laya-routed, budget-aware, multi-plan model routing + code graph.
// Hooks:
//   prompt                      -> Laya verdict + budget check + graph digest injected before the model sees anything
//   experimental.model.resolve  -> per-request model choice (cheap/heavy per policy), aux requests forced to the cheapest model
//   context                     -> budget-aware system note when a model passes 90% of a plan window
//   retry                       -> 429 marks the model "cooling" for 10 min and retries with backoff
// Command:
//   /6eyes                      -> status summary from .6eyes/status.json
// Plans: free | go | plus | teams | zen (auto from catalog, override with
// OPENCODE_PLAN or plugin option `plan`). When a paid plan runs dry, routing
// falls back to the free models, so a session never hard-stops.
// Everything fails open: if any part errors, the prompt passes through untouched.

import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { decide } from "./laya"
import { Budget } from "./budget"
import { route, expectedUsd, auxModel, budgetLineModels, pressure, resolvePlan, normalizePlan, type PlanId } from "./policy"
import { buildMap, digestOf, mapPath } from "./graph"
import { renderReport } from "./report"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export default Plugin.define({
  id: "6eyes",
  async setup(ctx: any) {
    if (ctx.options?.enabled === false) return

    let catalog: any = { models: [], plans: {} }
    try {
      catalog = JSON.parse(fs.readFileSync(path.join(HERE, "..", "catalog.json"), "utf8"))
    } catch {}

    const plan: PlanId = resolvePlan(catalog, ctx)

    // status cache (avoid re-reading storage on every model step)
    let stCache: { at: number; st: any } | null = null

    // Auto-detect the plan when the user has not set one: a connected
    // `opencode-go` provider means a paid plan (go is the safe, lower-capped
    // assumption for plus/teams), otherwise the free tier is in use.
    const explicitPlan = ctx.options?.plan ?? process.env.OPENCODE_PLAN
    const detectPlan = async (): Promise<PlanId> => {
      if (explicitPlan) return normalizePlan(explicitPlan, catalog)
      try {
        const list: any[] = (await (ctx.provider as any)?.list?.()) ?? []
        const ids = new Set(list.map((p: any) => p?.id ?? p?.provider?.id ?? p?.info?.id))
        if (ids.has("opencode-go")) return "go"
        if (ids.has("opencode")) return "free"
      } catch {}
      return normalizePlan(catalog?.defaultPlan, catalog)
    }
    const planReady: Promise<PlanId> = detectPlan().catch(() => plan)
    let activePlan: PlanId = plan

    const dir: string = ctx.location?.directory ?? process.cwd()
    const sixDir = path.join(dir, ".6eyes")
    const statePath = path.join(sixDir, "state.json")
    const statusPath = path.join(sixDir, "status.json")
    const reportPath = path.join(sixDir, "report.html")

    const budget = new Budget(ctx.storage)
    const cooling = new Map<string, number>()
    const pending = new Map<string, any>()
    const reqLog: any[] = []

    const readJson = (p: string): any => {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"))
      } catch {
        return null
      }
    }
    const writeJson = (p: string, v: any) => {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, JSON.stringify(v, null, 2))
      } catch {}
    }
    // Keep spend/session metadata out of the user's git history.
    const ensureIgnore = () => {
      try {
        const f = path.join(sixDir, ".gitignore")
        if (!fs.existsSync(f)) fs.writeFileSync(f, "*\n")
      } catch {}
    }

    const state: any = readJson(statePath) ?? { turns: [], lastCount: {} }

    const status = async () => {
      if (stCache && Date.now() - stCache.at < 30_000) return stCache.st
      const st = await budget.status(catalog, cooling, activePlan)
      stCache = { at: Date.now(), st }
      return st
    }

    const refreshGraph = async () => {
      try {
        const prev = readJson(mapPath(dir))
        const map = await buildMap(dir, prev)
        writeJson(mapPath(dir), map)
        state.graph = digestOf(map, state.prevNodeList)
        state.prevNodeList = (map.nodes ?? []).map((n: any) => n.f)
      } catch {}
    }

    const writeOutputs = async (d: any, v: any) => {
      const st = await status()
      try {
        fs.mkdirSync(sixDir, { recursive: true })
        ensureIgnore()
        writeJson(statusPath, { at: new Date().toISOString(), month: st.month, plan: st.plan, route: d, verdict: v, models: st.models })
        fs.writeFileSync(reportPath, renderReport({ st, catalog, turns: state.turns, graph: state.graph, dir, lastRoute: d }))
      } catch {}
      writeJson(statePath, state)
    }

    // ---------- 1) prompt admission: Laya first, always ----------
    await ctx.session.hook("prompt", async (event: any) => {
      try {
        const sid = event.sessionID
        const text: string = event.prompt?.text ?? ""

        // Resolve the plan once per prompt before any routing decision.
        const detected = await planReady
        if (detected !== activePlan) {
          activePlan = detected
          stCache = null
        }

        // account the previous turn (context delta) for the report
        try {
          const msgs: any[] = (await ctx.session.context({ sessionID: sid })) ?? []
          const last = state.lastCount[sid] ?? 0
          if (msgs.length > last) {
            state.turns.push({
              at: new Date().toISOString(),
              session: sid,
              messagesAdded: msgs.length - last,
              requests: reqLog.splice(0, reqLog.length),
            })
            state.turns = state.turns.slice(-50)
          }
          state.lastCount[sid] = msgs.length
        } catch {}

        // Laya verdict (local CPU, zero plan tokens)
        const v = await decide(text)

        // routing decision: verdict + budget + catalog + active plan
        const st = await status()
        const d = route(v, st, catalog, cooling, activePlan)
        pending.set(sid, { ...d, verdict: v })

        // refresh the graph in the background; digest from the map on disk so the
        // injected stats are never a turn behind
        const cachedMap = readJson(mapPath(dir))
        let g = cachedMap ? digestOf(cachedMap, state.prevNodeList) : null
        if (!g) {
          await refreshGraph()
          g = digestOf(readJson(mapPath(dir)), state.prevNodeList)
        } else {
          void refreshGraph()
        }

        await writeOutputs(d, v)

        // compact verdict block — prepended so the model sees it with this prompt
        const budgetLine = budgetLineModels(catalog, activePlan)
          .map((id) => {
            const u = st.models?.[id]
            if (!u) return ""
            return `${id} $${(u.usd ?? 0).toFixed(2)}/${u.usdLimit == null ? "free" : "$" + u.usdLimit}`
          })
          .filter(Boolean)
          .join(" · ")

        const lines = [
          `[6eyes] laya: type=${v.task_type ?? "?"} complexity=${v.complexity ?? "?"} reasoning=${v.reasoning ?? "?"} security=${v.security ?? "?"} risk=${v.risk ?? "?"} → tier=${d.tier} (classifier=${v.engine ?? "laya"})`,
          `route: primary=${d.provider}/${d.model} (${d.reason}) | aux(title/compaction)=cheapest tier | verdict attached — do NOT re-run laya-router for this prompt.`,
          `plan: ${st.plan} | budget ${st.month}: ${budgetLine}`,
        ]
        if (g) {
          const changed = (g.changed ?? []).slice(0, 5).join(", ")
          lines.push(
            `graph: ${g.files} files, ${g.edges} edges${g.hubs?.length ? `, hubs: ${g.hubs.slice(0, 4).join(", ")}` : ""}${changed ? `, changed: ${changed}` : ""} — open only the files you need instead of broad exploration.`,
          )
        }
        event.prompt.text = lines.join("\n") + "\n\n" + text
      } catch {
        // fail open: prompt passes through untouched
      }
    })

    // ---------- 2) per-request model routing ----------
    await ctx.session.hook("experimental.model.resolve", async (event: any) => {
      try {
        const p = pending.get(event.sessionID)

        // auxiliary requests (titles, compaction, transient generate) go to the cheapest model
        if (event.kind !== "primary") {
          const aux = auxModel(catalog, cooling, activePlan)
          if (aux.id !== event.model?.id || aux.providerID !== event.model?.providerID) {
            event.model = { providerID: aux.providerID, id: aux.id }
          }
          await budget.bump(aux.id, 0)
          return
        }

        if (!p) return // no verdict for this turn (e.g. resumed session) -> keep the session's selected model

        let model = p.model
        let provider = p.provider

        // hard budget guard: if the chosen model hit a plan window since the decision, re-route
        const st = await status()
        const u = st.models?.[model]
        if (u && ((u.usdLimit != null && u.usd >= u.usdLimit) || (u.usd5hCap != null && (u.usd5h ?? 0) >= u.usd5hCap))) {
          const d2 = route(p.verdict ?? { ok: false }, st, catalog, cooling, activePlan)
          model = d2.model
          provider = d2.provider
        }
        if ((cooling.get(model) ?? 0) > Date.now()) {
          const d2 = route(p.verdict ?? { ok: false }, st, catalog, cooling, activePlan)
          model = d2.model
          provider = d2.provider
        }

        if (model !== event.model?.id || provider !== event.model?.providerID) {
          event.model = { providerID: provider, id: model }
        }

        const c = (catalog.models ?? []).find((m: any) => m.id === model)
        const usd = c ? expectedUsd(c) : 0
        await budget.bump(model, usd) // exact request count, estimated USD (calibrated in v0.2)
        reqLog.push({ at: new Date().toISOString(), kind: event.kind, model, usd, tier: p.tier, reason: p.reason })
      } catch {}
    })

    // ---------- 3) budget-aware system note ----------
    await ctx.session.hook("context", async (event: any) => {
      try {
        const st = await status()
        const p = pressure(st, catalog, activePlan)
        const notes: string[] = []
        if (p.worstH5 >= 0.8) {
          notes.push(`5-hour window ${(p.worstH5 * 100).toFixed(0)}% used on ${p.worstId}; keep the next replies lean (smaller diffs, less re-reading).`)
        }
        if (p.exhausted > 0) {
          notes.push(`${p.exhausted}/${p.total} paid models exhausted for this month; routing continues on free models at $0 and quality may drop.`)
        }
        if (notes.length) {
          event.system.push({ type: "text", text: `[6eyes] ${notes.join(" ")}` })
        }
      } catch {}
    })

    // ---------- 4) 429 / auth handling ----------
    await ctx.session.hook("retry", (event: any) => {
      try {
        const id = event.model?.id
        const status = event.error?.status
        if (status === 429) {
          if (id) cooling.set(id, Date.now() + 10 * 60 * 1000)
          event.decision = { retry: true, delay: 10_000 }
          return
        }
        // No subscription / no credit for this model: route away for an hour
        // instead of retrying a model the account cannot use.
        if (status === 401 || status === 402 || status === 403) {
          if (id) cooling.set(id, Date.now() + 60 * 60 * 1000)
        }
      } catch {}
    })

    // ---------- 5) /6eyes command ----------
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "6eyes",
        description: "6eyes status: plan budgets, routing decisions, graph state",
        execute: async ({ sessionID, prompt, delivery }: any) => {
          await writeOutputs(pending.get(sessionID) ?? null, null)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text:
              "[6eyes] Read .6eyes/status.json and summarize in <=10 lines: active plan, monthly budget per model (used vs limit), last routing decision + reason, and graph stats. Do not run laya-router.",
          })
        },
      })
    })
  },
})
