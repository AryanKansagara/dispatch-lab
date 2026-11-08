import { useEffect, useRef, useState } from 'react'
import type { CityGeo } from './engine/city.ts'
import type { ScenarioId } from './engine/data.ts'
import type { ExperimentResult } from './engine/experiment.ts'
import type { Metrics } from './engine/metrics.ts'
import type { SweepPoint } from './engine/sweep.ts'
import type { Dataset, SimConfig, SimResult, StrategySpec } from './engine/types.ts'

export type Source = { kind: 'scenario'; id: ScenarioId; seed: number; city?: CityGeo } | { kind: 'data'; dataset: Dataset }

export type Request =
  | { kind: 'run'; source: Source; spec: StrategySpec; cfg: SimConfig }
  | { kind: 'sweep'; source: Source; spec: StrategySpec; cfg: SimConfig; steps: number; days: number }
  | { kind: 'experiment'; source: Source; a: StrategySpec; b: StrategySpec; cfg: SimConfig; days: number; regions: number; windowMin: number }

export interface RunOutput { result: SimResult; metrics: Metrics; ms: number }

const spawn = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

/** One long job on its own worker, so cancelling is just terminating it. */
export function startTask<T>(req: Request, onProgress?: (fraction: number) => void): { promise: Promise<T>; cancel(): void } {
  const w = spawn()
  const promise = new Promise<T>((resolve, reject) => {
    w.onmessage = e => {
      const m = e.data as { progress?: number; result?: T; error?: string }
      if (m.progress !== undefined) { onProgress?.(m.progress); return }
      w.terminate()
      if (m.error) reject(new Error(m.error))
      else resolve(m.result as T)
    }
    w.onerror = e => { w.terminate(); reject(new Error(e.message || 'The simulator stopped unexpectedly.')) }
  })
  w.postMessage({ id: 1, req })
  return { promise, cancel: () => w.terminate() }
}

export type SweepOutput = SweepPoint[]
export type ExperimentOutput = ExperimentResult

/**
 * Runs the simulator off the main thread whenever the request changes. While one run is in flight
 * only the newest request is kept, so dragging a slider never queues a backlog of stale runs.
 */
export function useRun(req: Request | null, key: string): { data: RunOutput | null; busy: boolean; error: string } {
  const [data, setData] = useState<RunOutput | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const worker = useRef<Worker | null>(null)
  const inFlight = useRef(false)
  const queued = useRef<Request | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const w = spawn()
    worker.current = w
    const send = (r: Request) => {
      inFlight.current = true
      setBusy(true)
      w.postMessage({ id: ++seq.current, req: r })
    }
    w.onmessage = e => {
      const m = e.data as { result?: RunOutput; error?: string }
      inFlight.current = false
      const next = queued.current
      queued.current = null
      if (m.error) setError(m.error)
      else if (m.result) { setData(m.result); setError('') }
      if (next) send(next)
      else setBusy(false)
    }
    w.onerror = e => { inFlight.current = false; setBusy(false); setError(e.message || 'The simulator stopped unexpectedly.') }
    if (queued.current) { const r = queued.current; queued.current = null; send(r) }
    return () => { w.terminate(); worker.current = null; inFlight.current = false }
  }, [])

  useEffect(() => {
    if (!req) return
    if (!worker.current || inFlight.current) { queued.current = req; return }
    inFlight.current = true
    setBusy(true)
    worker.current.postMessage({ id: ++seq.current, req })
    // The serialized key is the dependency; the request object is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { data, busy, error }
}
