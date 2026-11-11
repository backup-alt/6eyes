// 6eyes — routing policy. Combines the Laya verdict, live budget state, and the
// plan catalog into a per-request model choice. Deterministic, free, testable.
//
// Multi-plan (v0.2.0+): one catalog holds every OpenCode plan (free, go, plus,
// teams, zen). Token prices are identical across plans; only each model's
// monthly USD allowance changes. The 5h/weekly windows are fractions of that
// allowance (see catalog.limitsRule), so request caps are derived, never stored.
//
// Never-run-out ladder: cheapest available paid model -> any paid flash with
// budget left -> free models (unlimited, $0) -> Extra Usage advisory.
// Routing never returns "no model".

import type { Verdict } from "./laya"

export type PlanId = "free" | "go" | "plus" | "teams" | "zen"

export interface ModelRef {
  providerID: string
  id: string
}

export interface RouteDecision {
  tier: "cheap" | "heavy"
  model: string
  provider: string
  reason: string
}

const FALLBACK_PROVIDER = "opencode-go"

/** Normalize a plan name (env/config friendly) to a known plan id. */
export function normalizePlan(raw: unknown, catalog: any): PlanId {
  const s = String(raw ?? "").toLowerCase().trim()
  const known = Object.keys(catalog?.plans ?? {})
  if (s === "go-plus" || s === "goplus") return "plus"
  if (s === "go-teams" || s === "goteams") return "teams"
  if (known.includes(s)) return s as PlanId
  const d = String(catalog?.defaultPlan ?? "go").toLowerCase()
  return (known.includes(d) ? d : "go") as PlanId
}

/** Active plan: explicit plugin option, then env, then catalog default. */
export function resolvePlan(catalog: any, ctx?: any): PlanId {
  return normalizePlan(
    ctx?.options?.plan ?? process.env.OPENCODE_PLAN ?? catalog?.defaultPlan,
    catalog,
  )
}

export function planInfo(catalog: any, plan: PlanId): any {
  return catalog?.plans?.[plan] ?? null
}

/** Provider that serves this model on the given plan. */
export function providerOf(c: any, catalog: any, plan: PlanId): string {
  if (c?.provider) return c.provider
  return catalog?.plans?.[plan]?.provider ?? FALLBACK_PROVIDER
}

/** Monthly USD allowance for a model on a plan (null = unlimited / not metered). */
export function limitOf(c: any, catalog: any, plan: PlanId): number | null {
  if (!c) return null
  if (c.limits && Object.prototype.hasOwnProperty.call(c.limits, plan)) {
    const v = c.limits[plan]
    return v == null ? null : Number(v)
  }
  if (typeof c.monthlyUsd === "number") return c.monthlyUsd // legacy v1 catalog
  return null
}

/** Is this model usable under the active plan at all? */
export function onPlan(c: any, catalog: any, plan: PlanId): boolean {
  if (!c) return false
  const p = planInfo(catalog, plan)
  if (!p) return true
  // Free-plan users only get free-tier models; free models are a last resort
  // for every paid plan, so they are always "on plan".
  if (plan === "free") return c.free === true || c.class === "free"
  return true
}

/** Derived 5h / weekly USD caps from the model's monthly allowance. */
export function capsOf(c: any, catalog: any, plan: PlanId): { month: number | null; h5: number | null; week: number | null } {
  const month = limitOf(c, catalog, plan)
  if (month == null) return { month: null, h5: null, week: null }
  const rule = catalog?.limitsRule ?? { h5: 0.2, week: 0.5 }
  const h5 = Number(rule.h5 ?? 0.2)
  const week = Number(rule.week ?? 0.5)
  return { month, h5: month * h5, week: month * week }
}

export function isHeavy(v: Verdict): boolean {
  if (!v.ok) return false
  return (
    (v.complexity ?? 0) >= 2 ||
    (v.reasoning ?? 0) >= 0.5 ||
    (v.security ?? 0) >= 0.5 ||
    v.risk === "high"
  )
}

/** Current effective cost, handling DeepSeek peak windows, the Gemini promo expiry,
 *  and models priced per context tier (which carry `contextTiers` instead of `cost`). */
export function effectiveCost(c: any, now = new Date()): any {
  if (c.peak) {
    const d = now.getUTCDay()
    const h = now.getUTCHours()
    const peak = d >= 1 && d <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10))
    return peak ? c.peak : c.cost
  }
  if (c.promo?.until && new Date(c.promo.until) < now) return c.promo.cost
  if (c.cost) return c.cost
  if (Array.isArray(c.contextTiers) && c.contextTiers.length) return c.contextTiers[0].cost
  return { in: 0, out: 0, cacheR: 0, cacheW: 0 }
}

/** Estimated USD per request, using the plan's published per-request token profile. */
export function expectedUsd(c: any, now = new Date()): number {
  const k = effectiveCost(c, now)
  const e = c.est ?? { in: 800, cached: 55000, out: 250 }
  return (e.in * k.in + e.cached * (k.cacheR ?? 0) + e.out * k.out) / 1e6
}

// task_type -> preferred heavy-tier models (fit bonus; ids must exist in the catalog)
const FIT: Record<string, string[]> = {
  coding: ["glm-5.3", "kimi-k2.7-code", "glm-5.3-flash", "deepseek-v4.1-flash"],
  implementation: ["glm-5.3", "kimi-k2.7-code", "glm-5.3-flash", "deepseek-v4.1-flash"],
  backend: ["glm-5.3", "kimi-k2.7-code", "glm-5.3-flash", "deepseek-v4.1-flash"],
  frontend: ["glm-5.3", "kimi-k2.7-code", "glm-5.3-flash", "deepseek-v4.1-flash"],
  debugging: ["glm-5.3", "kimi-k2.7-code", "glm-5.3-flash", "deepseek-v4.1-flash"],
  architecture: ["kimi-k3.1-pro", "qwen3.8-max", "gemini-4-argon", "grok-4.7"],
  security: ["kimi-k3.1-pro", "deepseek-v4-pro", "grok-4.7"],
  research: ["gemini-4-argon", "kimi-k3.1-pro", "qwen3.8-max"],
  data: ["qwen3.8-max", "gemini-4-argon"],
  ai: ["grok-4.7", "kimi-k3.1-pro"],
  devops: ["kimi-k2.7-code", "deepseek-v4-pro", "deepseek-v4.1-flash", "glm-5.3-flash"],
  testing: ["kimi-k2.7-code", "glm-5.3", "glm-5.3-flash", "deepseek-v4.1-flash"],
  documentation: ["longcat-2.0", "qwen3.7-plus"],
}

/** Free-tier models: unlimited and $0. Terminal fallback that never exhausts.
 *  Sorted by `rank` so stable Zen free models beat limited-region Go ones. */
function freePool(catalog: any): any[] {
  return (catalog?.models ?? [])
    .filter((c: any) => c.free === true || c.class === "free")
    .sort((a: any, b: any) => (a.rank ?? 99) - (b.rank ?? 99))
}

/** Free candidates for routing: the best `top` ranked models, least-used first.
 *  Free models have per-model daily caps, so spreading load across the best few
 *  avoids burning one model into a 429 while the others sit idle. */
function freeCandidates(catalog: any, st: any, top = 3): any[] {
  const pool = freePool(catalog).slice(0, Math.max(1, top))
  const used = (id: string) => st?.models?.[id]?.req5h ?? 0
  return pool.sort((a: any, b: any) => used(a.id) - used(b.id) || (a.rank ?? 99) - (b.rank ?? 99))
}

/** Paid models on this plan, cheapest first. */
function paidByCost(catalog: any, plan: PlanId): any[] {
  return (catalog?.models ?? [])
    .filter((c: any) => c.free !== true && c.class !== "free" && onPlan(c, catalog, plan))
    .sort((a: any, b: any) => expectedUsd(a) - expectedUsd(b))
}

export function route(
  v: Verdict,
  st: any,
  catalog: any,
  cooling: Map<string, number>,
  plan: PlanId = "go",
): RouteDecision {
  const models: any[] = catalog?.models ?? []
  const byId = new Map<string, any>(models.map((c: any) => [c.id, c]))
  const u = (id: string) => st?.models?.[id] ?? null
  const avail = (c: any) => {
    if (!c || !onPlan(c, catalog, plan)) return false
    if (c.free === true || c.class === "free") return (cooling.get(c.id) ?? 0) <= Date.now()
    const s = u(c.id)
    if (!s) return (cooling.get(c.id) ?? 0) <= Date.now()
    if ((cooling.get(c.id) ?? 0) > Date.now()) return false
    const caps = capsOf(c, catalog, plan)
    if (caps.month != null && s.usd >= caps.month * 0.98) return false
    if (caps.h5 != null && s.usd5h != null && s.usd5h >= caps.h5 * 0.98) return false
    if (s.req5hCap != null && s.req5h >= s.req5hCap * 0.98) return false
    return true
  }
  const remaining = (c: any) => {
    const s = u(c.id)
    const caps = capsOf(c, catalog, plan)
    if (caps.month == null) return Number.MAX_SAFE_INTEGER
    return Math.max(0, caps.month - (s?.usd ?? 0))
  }
  const decide = (tier: "cheap" | "heavy", c: any, reason: string): RouteDecision => ({
    tier,
    model: c.id,
    provider: providerOf(c, catalog, plan),
    reason,
  })
  const freeFallback = (tier: "cheap" | "heavy", reason: string): RouteDecision => {
    const f = freeCandidates(catalog, st).filter(avail)
    if (f[0]) return decide(tier, f[0], reason)
    const anyFree = freePool(catalog)[0]
    if (anyFree) return decide(tier, anyFree, reason + " (free, cooling)")
    const first = models[0]
    return { tier, model: first?.id ?? "muse-spark-1.3-contributor", provider: providerOf(first, catalog, plan), reason: "catalog empty -> default" }
  }

  const paid = paidByCost(catalog, plan)

  // Free plan (or all-paid-exhausted on any plan): stay on $0 models.
  if (plan === "free") {
    const f = freeCandidates(catalog, st).filter(avail)
    return decide("cheap", f[0] ?? freePool(catalog)[0], "plan=free -> free models only")
  }

  // Laya unavailable -> cheapest fail-safe (never blocks the prompt)
  if (!v.ok) {
    const c = paid.find(avail)
    if (c) return decide("cheap", c, "laya unavailable -> cheapest fail-safe")
    return freeFallback("cheap", "laya unavailable + no paid budget -> free model")
  }

  // CHEAP tier: complexity < 2, low reasoning/security, risk != high
  if (!isHeavy(v)) {
    const c = paid.find(avail)
    if (c) return decide("cheap", c, `complexity<2, low reasoning/risk -> cheapest ($${expectedUsd(c).toFixed(5)}/req)`)
    const best = paid.filter(avail).sort((a: any, b: any) => remaining(b) - remaining(a))[0]
    if (best) return decide("cheap", best, "cheap chain constrained -> best-remaining paid")
    return freeFallback("cheap", "paid budgets exhausted -> free model ($0, unlimited)")
  }

  // HEAVY tier: task_type fit first, then premium/mid, then flash, then free.
  const fit = FIT[v.task_type ?? ""] ?? []
  const pool = paid
    .filter((c: any) => {
      if (!avail(c)) return false
      if (fit.includes(c.id)) return true
      return c.class === "premium" || (c.class === "mid" && (limitOf(c, catalog, plan) ?? 0) >= 60)
    })
    .sort((a: any, b: any) => {
      const fa = fit.includes(a.id) ? 1 : 0
      const fb = fit.includes(b.id) ? 1 : 0
      if (fa !== fb) return fb - fa
      if (fa && fb) return expectedUsd(a) - expectedUsd(b)
      return remaining(b) - remaining(a)
    })
  if (pool[0]) {
    const why = (fit.includes(pool[0].id) ? `task_type=${v.task_type} fit + ` : "") +
      `$${remaining(pool[0]) === Number.MAX_SAFE_INTEGER ? "unlimited" : remaining(pool[0]).toFixed(0)} left`
    return decide("heavy", pool[0], why)
  }
  const fl = paid.filter((c: any) => c.class === "flash" && avail(c)).sort((a: any, b: any) => remaining(b) - remaining(a))
  if (fl[0]) return decide("heavy", fl[0], "premium budgets exhausted -> best-remaining flash")
  return freeFallback("heavy", "all paid budgets exhausted -> free model (quality degraded)")
}

/** Cheapest model for auxiliary requests (titles, compaction, transient generate). */
export function auxModel(catalog: any, cooling: Map<string, number>, plan: PlanId = "go"): ModelRef {
  const paid = paidByCost(catalog, plan).filter((c: any) => (cooling.get(c.id) ?? 0) <= Date.now())
  if (paid[0]) return { providerID: providerOf(paid[0], catalog, plan), id: paid[0].id }
  const pool = freePool(catalog)
  const f = pool.find((c: any) => (cooling.get(c.id) ?? 0) <= Date.now()) ?? pool[0]
  if (f) return { providerID: providerOf(f, catalog, plan), id: f.id }
  return { providerID: FALLBACK_PROVIDER, id: "muse-spark-1.3-contributor" }
}

/** Curated subset shown on the injected budget line (cheap leaders + big allowances). */
export function budgetLineModels(catalog: any, plan: PlanId = "go"): string[] {
  if (plan === "free") return freeCandidates(catalog, {}, 4).map((c: any) => c.id)
  const paid = paidByCost(catalog, plan)
  const cheap = paid.slice(0, 3)
  const big = [...paid].sort((a: any, b: any) => (limitOf(b, catalog, plan) ?? 0) - (limitOf(a, catalog, plan) ?? 0)).slice(0, 3)
  return [...new Set([...cheap, ...big].map((c: any) => c.id))]
}

/** How much of the current 5h window / month is used, for warnings and reports. */
export function pressure(st: any, catalog: any, plan: PlanId) {
  let worstH5 = 0
  let worstId = ""
  let exhausted = 0
  let total = 0
  for (const c of catalog?.models ?? []) {
    if (c.free === true || c.class === "free") continue
    const caps = capsOf(c, catalog, plan)
    if (caps.month == null) continue
    total++
    const s = st?.models?.[c.id]
    if (!s) continue
    if (s.usd >= caps.month) exhausted++
    const p = caps.h5 ? (s.usd5h ?? 0) / caps.h5 : 0
    if (p > worstH5) {
      worstH5 = p
      worstId = c.id
    }
  }
  return { worstH5, worstId, exhausted, total }
}
