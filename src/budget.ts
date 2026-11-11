// 6eyes — plan budget ledger, stored in plugin storage (durable, account-wide).
// Tracks monthly USD, 5-hour-window USD, and per-window request counts against
// the active plan's catalog limits. Request counts are exact; USD is estimated
// from the plan's published per-request token profile until v0.2 calibration.

import { capsOf, expectedUsd, limitOf, planInfo, type PlanId } from "./policy"

const H5 = 5 * 3600 * 1000

export interface Usage {
  usd: number
  requests: number
}

export class Budget {
  constructor(private storage: any) {}

  private monthKey(d = new Date()): string {
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0")
  }

  private slot(d = Date.now()): number {
    return Math.floor(d / H5)
  }

  /** Record one model request. `usd` is the estimated cost of the request. */
  async bump(modelId: string, usd: number): Promise<void> {
    try {
      const mk = "6eyes:m:" + this.monthKey() + ":" + modelId
      const hk = "6eyes:h:" + this.slot() + ":" + modelId
      const m: Usage = (await this.storage.get(mk)) ?? { usd: 0, requests: 0 }
      m.usd += usd
      m.requests += 1
      await this.storage.set(mk, m)
      const h: Usage = (await this.storage.get(hk)) ?? { usd: 0, requests: 0 }
      h.usd += usd
      h.requests += 1
      await this.storage.set(hk, h)
    } catch {}
  }

  /** Snapshot of every model's usage vs the active plan's limits, plus cooling state. */
  async status(catalog: any, cooling: Map<string, number>, plan: PlanId = "go"): Promise<any> {
    const month = this.monthKey()
    const models: any = {}
    for (const c of catalog?.models ?? []) {
      const m: Usage = (await this.storage.get("6eyes:m:" + month + ":" + c.id)) ?? { usd: 0, requests: 0 }
      const h: Usage = (await this.storage.get("6eyes:h:" + this.slot() + ":" + c.id)) ?? { usd: 0, requests: 0 }
      const caps = capsOf(c, catalog, plan)
      const perReq = expectedUsd(c)
      models[c.id] = {
        usd: m.usd,
        requests: m.requests,
        usdLimit: caps.month ?? limitOf(c, catalog, plan),
        usd5h: h.usd,
        usd5hCap: caps.h5,
        req5h: h.requests,
        req5hCap: caps.h5 != null && perReq > 0 ? Math.round(caps.h5 / perReq) : null,
        reqWeekCap: caps.week != null && perReq > 0 ? Math.round(caps.week / perReq) : null,
        reqMonthCap: caps.month != null && perReq > 0 ? Math.round(caps.month / perReq) : null,
        free: c.free === true || c.class === "free",
        coolingUntil: cooling.get(c.id) ?? 0,
      }
    }
    const p = planInfo(catalog, plan)
    return {
      month,
      plan,
      planName: p?.kind ?? plan,
      planPrice: p?.price ?? null,
      models,
    }
  }
}
