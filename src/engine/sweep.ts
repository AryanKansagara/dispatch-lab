import { computeMetrics, mean, paretoFront, type Metrics } from './metrics.ts'
import { simulate } from './sim.ts'
import { makeStrategy } from './strategies.ts'
import type { Dataset, SimConfig, StrategySpec } from './types.ts'

export interface SweepPoint { batch: number; metrics: Metrics; onFrontier: boolean }

/** The three sides of the trade-off, each higher-is-better: efficiency, food, courier pay. */
export const tradeoffVector = (m: Metrics) => [-m.courierMinPerDelivery, m.tempMean, m.payPerActiveHour]

/** Averages over days so the frontier reflects the policy rather than one day's noise. */
export function runSweep(
  makeDay: (day: number) => Dataset, base: StrategySpec, cfg: SimConfig, steps: number, days: number,
  onProgress?: (done: number, total: number) => void,
): SweepPoint[] {
  const total = steps * days
  let done = 0
  const points = Array.from({ length: steps }, (_, s) => {
    const batch = steps > 1 ? s / (steps - 1) : base.batch
    const strategy = makeStrategy({ ...base, id: 'optimizer', batch })
    const runs: Metrics[] = []
    for (let d = 0; d < days; d++) {
      runs.push(computeMetrics(simulate(makeDay(d), strategy, cfg)))
      onProgress?.(++done, total)
    }
    const metrics = Object.fromEntries(
      (Object.keys(runs[0]) as (keyof Metrics)[]).map(k => [k, mean(runs.map(r => r[k]))]),
    ) as unknown as Metrics
    return { batch, metrics, onFrontier: false }
  })
  const front = new Set(paretoFront(points.map(p => tradeoffVector(p.metrics))))
  points.forEach((p, i) => { p.onFrontier = front.has(i) })
  return points
}
