import { computeMetrics } from './engine/metrics.ts'
import { generateCity, resampleDay } from './engine/data.ts'
import { runExperiment } from './engine/experiment.ts'
import { simulate } from './engine/sim.ts'
import { makeStrategy } from './engine/strategies.ts'
import { runSweep } from './engine/sweep.ts'
import type { Request, Source } from './client.ts'
import type { Dataset } from './engine/types.ts'

const dayOf = (source: Source, seed: number) => (day: number): Dataset =>
  source.kind === 'scenario'
    ? generateCity(source.id, source.seed, day, source.city)
    : day === 0 ? source.dataset : resampleDay(source.dataset, seed * 97 + day)

self.onmessage = (e: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = e.data
  const progress = (done: number, total: number) => self.postMessage({ id, progress: done / total })
  try {
    if (req.kind === 'run') {
      const started = performance.now()
      const result = simulate(dayOf(req.source, req.cfg.seed)(0), makeStrategy(req.spec), req.cfg)
      self.postMessage({ id, result: { result, metrics: computeMetrics(result), ms: performance.now() - started } })
    } else if (req.kind === 'sweep') {
      const points = runSweep(dayOf(req.source, req.cfg.seed), req.spec, req.cfg, req.steps, req.days, progress)
      self.postMessage({ id, result: points })
    } else {
      const result = runExperiment({
        makeDay: dayOf(req.source, req.cfg.seed),
        a: req.a, b: req.b, cfg: req.cfg, days: req.days,
        regionsPerSide: req.regions, windowMin: req.windowMin, seed: req.cfg.seed,
      }, progress)
      self.postMessage({ id, result })
    }
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
