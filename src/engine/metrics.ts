import type { OrderState, SimResult } from './types.ts'

/** Food temperature model: Newton cooling from the moment it is ready, slower once in an insulated bag. */
export const TEMP = { hotC: 74, ambientC: 22, shelfK: 0.035, bagK: 0.02, coldBelowC: 50 }

export function tempAt(o: Pick<OrderState, 'readyAt' | 'pickedAt'>, t: number): number {
  const { hotC, ambientC, shelfK, bagK } = TEMP
  if (t <= o.readyAt) return hotC
  const picked = o.pickedAt >= 0 ? o.pickedAt : Infinity
  const onShelf = Math.min(t, picked) - o.readyAt
  const inBag = Math.max(0, t - picked)
  return ambientC + (hotC - ambientC) * Math.exp(-shelfK * onShelf - bagK * inBag)
}

export function quantile(values: number[], q: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}

export const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)

/** Credit owed on one order: badly late (15 min past the promise), cold, or never delivered. */
export function refundOf(o: OrderState, refund: number): number {
  if (o.deliveredAt < 0) return refund
  return o.deliveredAt > o.promiseAt + 15 || tempAt(o, o.deliveredAt) < TEMP.coldBelowC ? refund : 0
}

export interface StackInfo { id: number; size: number; courier: number; lowest: number; total: number; lowestOrder: number }

export function stacksOf(r: SimResult): StackInfo[] {
  const byId = new Map<number, OrderState[]>()
  for (const o of r.orders) {
    if (o.stackId < 0) continue
    const g = byId.get(o.stackId)
    if (g) g.push(o)
    else byId.set(o.stackId, [o])
  }
  const out: StackInfo[] = []
  for (const [id, g] of byId) {
    if (g.length < 2) continue
    const low = g.reduce((m, o) => (o.pay < m.pay ? o : m))
    out.push({ id, size: g.length, courier: g[0].courier, lowest: low.pay, lowestOrder: low.index, total: g.reduce((s, o) => s + o.pay, 0) })
  }
  return out
}

export interface Metrics {
  orders: number
  delivered: number
  unfulfilledRate: number
  deliveryP50: number
  deliveryP90: number
  foodWaitMean: number
  foodWaitP90: number
  tempMean: number
  coldRate: number
  lateRate: number
  utilization: number
  payPerActiveHour: number
  payPerOnlineHour: number
  payPerMile: number
  stackShare: number
  avgStackSize: number
  /** The single worst-paid order inside any stack. */
  worstStackPay: number
  /** Median pay of the lowest-paid order per stack. */
  medianLowestInStack: number
  /** Share of stacks hiding an order under the low-pay line. */
  hiddenLowPayRate: number
  platformCost: number
  milesPerDelivery: number
  courierMinPerDelivery: number
}

export function computeMetrics(r: SimResult): Metrics {
  const done = r.orders.filter(o => o.deliveredAt >= 0)
  // Undelivered orders stay in the quality metrics, censored at the end of the run and counted late
  // and cold. Dropping them would reward a strategy for abandoning its hardest orders.
  const times = r.orders.map(o => (o.deliveredAt >= 0 ? o.deliveredAt : r.horizon) - o.createdAt)
  const waits = r.orders.map(o => Math.max(0, (o.pickedAt >= 0 ? o.pickedAt : r.horizon) - o.readyAt))
  const temps = r.orders.map(o => (o.deliveredAt >= 0 ? tempAt(o, o.deliveredAt) : TEMP.ambientC))
  const stacks = stacksOf(r)
  const inStacks = stacks.reduce((s, k) => s + k.size, 0)
  const lows = stacks.map(k => k.lowest)
  const pay = r.couriers.reduce((s, c) => s + c.pay, 0)
  const active = r.couriers.reduce((s, c) => s + c.activeMin, 0)
  const online = r.couriers.reduce((s, c) => s + c.onlineMin, 0)
  const miles = r.couriers.reduce((s, c) => s + c.miles, 0)
  const platform = r.orders.reduce((s, o) => s + o.basePaid + refundOf(o, r.cfg.refund), 0)
  const assigned = r.orders.filter(o => o.courier >= 0).length
  const n = r.orders.length
  return {
    orders: n,
    delivered: done.length,
    unfulfilledRate: n ? 1 - done.length / n : 0,
    deliveryP50: quantile(times, 0.5),
    deliveryP90: quantile(times, 0.9),
    foodWaitMean: mean(waits),
    foodWaitP90: quantile(waits, 0.9),
    tempMean: mean(temps),
    coldRate: n ? temps.filter(t => t < TEMP.coldBelowC).length / n : 0,
    lateRate: n ? r.orders.filter(o => o.deliveredAt < 0 || o.deliveredAt > o.promiseAt).length / n : 0,
    utilization: online ? Math.min(1, active / online) : 0,
    payPerActiveHour: active ? pay / (active / 60) : 0,
    payPerOnlineHour: online ? pay / (online / 60) : 0,
    payPerMile: miles ? pay / miles : 0,
    stackShare: assigned ? inStacks / assigned : 0,
    avgStackSize: stacks.length ? inStacks / stacks.length : 1,
    worstStackPay: lows.length ? Math.min(...lows) : 0,
    medianLowestInStack: quantile(lows, 0.5),
    hiddenLowPayRate: stacks.length ? lows.filter(l => l < r.cfg.lowPayLine).length / stacks.length : 0,
    platformCost: done.length ? platform / done.length : 0,
    milesPerDelivery: done.length ? miles / done.length : 0,
    courierMinPerDelivery: done.length ? active / done.length : 0,
  }
}

/** Indices of points no other point beats on every objective (all higher-is-better). */
export function paretoFront(points: number[][]): number[] {
  return points.flatMap((p, i) =>
    points.some((q, j) => j !== i && q.every((v, k) => v >= p[k]) && q.some((v, k) => v > p[k])) ? [] : [i])
}
