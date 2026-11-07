import { refundOf, tempAt, TEMP, mean } from './metrics.ts'
import { rngFrom, simulate } from './sim.ts'
import { makeStrategy } from './strategies.ts'
import type { Dataset, OrderState, SimConfig, SimResult, StrategySpec } from './types.ts'

export type OutcomeId = 'deliveryMin' | 'foodWait' | 'temp' | 'late' | 'cost' | 'pay' | 'stacked'

export const OUTCOMES: Record<OutcomeId, { label: string; unit: string; better: 'low' | 'high' }> = {
  deliveryMin: { label: 'Delivery time', unit: 'min', better: 'low' },
  foodWait: { label: 'Food wait after ready', unit: 'min', better: 'low' },
  temp: { label: 'Temperature at the door', unit: '°C', better: 'high' },
  late: { label: 'Late rate', unit: 'pts', better: 'low' },
  cost: { label: 'Platform cost per order', unit: '$', better: 'low' },
  pay: { label: 'Courier pay per order', unit: '$', better: 'high' },
  stacked: { label: 'Share in stacks', unit: 'pts', better: 'high' },
}

const OUTCOME_IDS = Object.keys(OUTCOMES) as OutcomeId[]

/** Per-order outcome. An undelivered order is censored at the end of the run, cold and credited. */
export function outcome(o: OrderState, id: OutcomeId, r: SimResult, stackSizes: Map<number, number>): number {
  const done = o.deliveredAt >= 0
  switch (id) {
    case 'deliveryMin': return (done ? o.deliveredAt : r.horizon) - o.createdAt
    case 'foodWait': return Math.max(0, (o.pickedAt >= 0 ? o.pickedAt : r.horizon) - o.readyAt)
    case 'temp': return done ? tempAt(o, o.deliveredAt) : TEMP.ambientC
    case 'late': return !done || o.deliveredAt > o.promiseAt ? 100 : 0
    case 'cost': return o.basePaid + refundOf(o, r.cfg.refund)
    case 'pay': return o.pay
    case 'stacked': return (stackSizes.get(o.stackId) ?? 0) > 1 ? 100 : 0
  }
}

function stackSizesOf(r: SimResult) {
  const m = new Map<number, number>()
  for (const o of r.orders) if (o.stackId >= 0) m.set(o.stackId, (m.get(o.stackId) ?? 0) + 1)
  return m
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

/** Two-sided 95% Student t critical value (Cornish-Fisher expansion, accurate from about 3 df). */
export function t975(df: number): number {
  const z = 1.959964
  if (!Number.isFinite(df) || df > 1e6) return z
  const d = Math.max(df, 1)
  return z + (z ** 3 + z) / (4 * d) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * d ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * d ** 3)
}

export interface Estimate { diff: number; se: number; lo: number; hi: number; n: number; clusters: number }

/**
 * Difference in means from y ~ treated, with a CR1 cluster-robust sandwich variance.
 * Units are weighted equally, so this is the simple average of time-region units. The t critical
 * value uses clusters minus one degrees of freedom, because few clusters make the sandwich optimistic.
 */
export function clusterRobustDiff(rows: { y: number; treated: boolean; cluster: string }[]): Estimate {
  const n = rows.length
  const n1 = rows.filter(r => r.treated).length
  const n0 = n - n1
  const m1 = mean(rows.filter(r => r.treated).map(r => r.y))
  const m0 = mean(rows.filter(r => !r.treated).map(r => r.y))
  const diff = m1 - m0
  const xBar = n1 / Math.max(n, 1)
  const sxx = n1 * (1 - xBar) ** 2 + n0 * xBar ** 2
  const scores = new Map<string, number>()
  for (const r of rows) {
    const x = r.treated ? 1 : 0
    const e = r.y - (r.treated ? m1 : m0)
    scores.set(r.cluster, (scores.get(r.cluster) ?? 0) + (x - xBar) * e)
  }
  const G = scores.size
  let meat = 0
  for (const s of scores.values()) meat += s * s
  const correction = G > 1 && n > 2 ? (G / (G - 1)) * ((n - 1) / (n - 2)) : 1
  const se = sxx > 0 ? Math.sqrt(correction * meat) / sxx : 0
  const crit = t975(G - 1)
  return { diff, se, lo: diff - crit * se, hi: diff + crit * se, n, clusters: G }
}

/** Plain two-sample estimate that wrongly treats each order as independent. */
export function welchDiff(a: number[], b: number[]): Estimate {
  const ma = mean(a)
  const mb = mean(b)
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / Math.max(a.length - 1, 1)
  const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / Math.max(b.length - 1, 1)
  const se = Math.sqrt(va / Math.max(a.length, 1) + vb / Math.max(b.length, 1))
  const diff = mb - ma
  return { diff, se, lo: diff - 1.96 * se, hi: diff + 1.96 * se, n: a.length + b.length, clusters: a.length + b.length }
}

export const powerAt = (effect: number, se: number) => {
  if (se <= 0) return 1
  const z = Math.abs(effect) / se
  return normCdf(z - 1.959964) + normCdf(-z - 1.959964)
}

/** Standard error shrinks with the root of run length, so required length scales with its square. */
export function daysForPower(effect: number, seAtDays: number, days: number): number {
  if (effect === 0) return Infinity
  return Math.max(1, Math.ceil(days * (((1.959964 + 0.841621) * seAtDays) / Math.abs(effect)) ** 2))
}

export interface ExperimentParams {
  /** Same day index means the same demand across every arm, which pairs the comparison. */
  makeDay(day: number): Dataset
  a: StrategySpec
  b: StrategySpec
  cfg: SimConfig
  days: number
  regionsPerSide: number
  windowMin: number
  seed: number
}

export interface OutcomeResult {
  /** All-A versus all-B on the same days: the truth a real marketplace never gets to see. */
  truth: number
  control: number
  switchback: Estimate
  naive: Estimate
  naiveBias: number
  switchbackBias: number
  /** Chance this run length detects the true effect. */
  power: number
  daysFor80: number
  naiveDaysFor80: number
}

export interface GridCell { region: number; window: number; treated: boolean; orders: number; value: number }

export interface ExperimentResult {
  outcomes: Record<OutcomeId, OutcomeResult>
  days: number
  units: number
  /** First-day assignment calendar. */
  grid: GridCell[]
  regions: number
  windows: number
  windowMin: number
  ordersPerDay: number
}

const stable = (seed: number, a: number, b: number, c: number) => rngFrom(Math.imul(seed + 1, 2654435761) ^ Math.imul(a + 1, 40503) ^ Math.imul(b + 1, 2147483647) ^ Math.imul(c + 1, 16777619))()

/** Region boundaries come from store quantiles, so each region carries comparable volume. */
export function regionIndexer(data: Dataset, perSide: number) {
  const lats = data.orders.map(o => o.store.lat).sort((a, b) => a - b)
  const lngs = data.orders.map(o => o.store.lng).sort((a, b) => a - b)
  const cut = (v: number[]) => Array.from({ length: perSide - 1 }, (_, i) => v[Math.floor(((i + 1) * v.length) / perSide)])
  const latCuts = cut(lats)
  const lngCuts = cut(lngs)
  const bin = (x: number, cuts: number[]) => {
    let k = 0
    while (k < cuts.length && x >= cuts[k]) k++
    return k
  }
  return (o: { store: { lat: number; lng: number } }) => bin(o.store.lat, latCuts) * perSide + bin(o.store.lng, lngCuts)
}

/**
 * Runs the whole design on the same simulated days: global A and global B for the truth, a
 * switchback randomized over time-region units, and a naive order-level A/B on a shared fleet.
 *
 * An order keeps the variant of the unit it was created in, so neither arm can cherry-pick work
 * and leave the other to clean up. Couriers still cross units, which is the carryover that remains.
 */
export function runExperiment(p: ExperimentParams, onProgress?: (done: number, total: number) => void): ExperimentResult {
  const stratA = makeStrategy(p.a)
  const stratB = makeStrategy(p.b)
  const unitRows: Record<OutcomeId, { y: number; treated: boolean; cluster: string }[]> = Object.fromEntries(OUTCOME_IDS.map(k => [k, []])) as never
  const naiveA: Record<OutcomeId, number[]> = Object.fromEntries(OUTCOME_IDS.map(k => [k, []])) as never
  const naiveB: Record<OutcomeId, number[]> = Object.fromEntries(OUTCOME_IDS.map(k => [k, []])) as never
  const allA: Record<OutcomeId, number[]> = Object.fromEntries(OUTCOME_IDS.map(k => [k, []])) as never
  const allB: Record<OutcomeId, number[]> = Object.fromEntries(OUTCOME_IDS.map(k => [k, []])) as never
  const grid: GridCell[] = []
  let units = 0
  let windows = 0
  let ordersTotal = 0
  const total = p.days * 4
  let done = 0
  const tick = () => { done++; onProgress?.(done, total) }

  for (let day = 0; day < p.days; day++) {
    const data = p.makeDay(day)
    ordersTotal += data.orders.length
    const regionOf = regionIndexer(data, p.regionsPerSide)
    const treatedUnit = (region: number, window: number) => stable(p.seed, day, region, window) < 0.5
    const windowOf = (t: number) => Math.floor(t / p.windowMin)

    const runA = simulate(data, stratA, p.cfg); tick()
    const runB = simulate(data, stratB, p.cfg); tick()
    const sizesA = stackSizesOf(runA)
    const sizesB = stackSizesOf(runB)
    for (const k of OUTCOME_IDS) {
      for (const o of runA.orders) allA[k].push(outcome(o, k, runA, sizesA))
      for (const o of runB.orders) allB[k].push(outcome(o, k, runB, sizesB))
    }

    const sbTreated = (o: OrderState) => treatedUnit(regionOf(o.src), windowOf(o.createdAt))
    const sb = simulate(data, [
      { strategy: stratA, belongs: o => !sbTreated(o) },
      { strategy: stratB, belongs: sbTreated },
    ], p.cfg); tick()
    const sbSizes = stackSizesOf(sb)
    const buckets = new Map<string, OrderState[]>()
    for (const o of sb.orders) {
      const key = `${regionOf(o.src)}:${windowOf(o.createdAt)}`
      const b = buckets.get(key)
      if (b) b.push(o)
      else buckets.set(key, [o])
    }
    units += buckets.size
    for (const [key, list] of buckets) {
      const [region, window] = key.split(':').map(Number)
      windows = Math.max(windows, window + 1)
      const treated = treatedUnit(region, window)
      for (const k of OUTCOME_IDS) {
        const y = mean(list.map(o => outcome(o, k, sb, sbSizes)))
        // Serial correlation lives inside a region on a day, so that is the cluster.
        unitRows[k].push({ y, treated, cluster: `${day}/${region}` })
      }
      if (day === 0) grid.push({ region, window, treated, orders: list.length, value: mean(list.map(o => outcome(o, 'deliveryMin', sb, sbSizes))) })
    }

    const naiveTreated = new Uint8Array(data.orders.length)
    const coin = rngFrom(p.seed * 31 + day * 977 + 5)
    naiveTreated.forEach((_, i) => { naiveTreated[i] = coin() < 0.5 ? 1 : 0 })
    const naive = simulate(data, [
      { strategy: stratA, belongs: o => !naiveTreated[o.index] },
      { strategy: stratB, belongs: o => !!naiveTreated[o.index] },
    ], p.cfg); tick()
    const naiveSizes = stackSizesOf(naive)
    for (const k of OUTCOME_IDS) {
      for (const o of naive.orders) (naiveTreated[o.index] ? naiveB : naiveA)[k].push(outcome(o, k, naive, naiveSizes))
    }
  }

  const outcomes = Object.fromEntries(OUTCOME_IDS.map(k => {
    const truth = mean(allB[k]) - mean(allA[k])
    const switchback = clusterRobustDiff(unitRows[k])
    const naive = welchDiff(naiveA[k], naiveB[k])
    const r: OutcomeResult = {
      truth,
      control: mean(allA[k]),
      switchback,
      naive,
      naiveBias: naive.diff - truth,
      switchbackBias: switchback.diff - truth,
      power: powerAt(truth, switchback.se),
      daysFor80: daysForPower(truth, switchback.se, p.days),
      naiveDaysFor80: daysForPower(truth, naive.se, p.days),
    }
    return [k, r]
  })) as Record<OutcomeId, OutcomeResult>

  return {
    outcomes, days: p.days, units, grid, windows, windowMin: p.windowMin,
    regions: p.regionsPerSide ** 2,
    ordersPerDay: Math.round(ordersTotal / p.days),
  }
}
