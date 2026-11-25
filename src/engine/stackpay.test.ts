import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeMetrics } from './metrics.ts'
import { simulate } from './sim.ts'
import { makeStrategy } from './strategies.ts'
import { runSweep } from './sweep.ts'
import { DEFAULT_CONFIG, type Dataset } from './types.ts'

const at = (lat: number) => ({ lat, lng: 20 })
/** One order per payout, all from one store to one door at the same minute, for a single courier. */
const day = (...payouts: number[]): Dataset => ({
  name: 'Test', synthetic: false,
  orders: payouts.map((payout, i) => ({ id: `o${i}`, createdAt: 0, store: at(10), customer: at(10.02), prepMin: 5, payout })),
  couriers: [{ id: 'C1', shiftStart: 0, shiftEnd: 300, start: at(10) }],
})
const run = (d: Dataset, id: 'greedy' | 'batch') => computeMetrics(simulate(d, makeStrategy({ id, batch: 0.5, fresh: 0.5, pay: 0 }), DEFAULT_CONFIG))

test('an unpaid order in a stack is the $0 worst pay', () => {
  const m = run(day(0, 12), 'batch')
  assert.equal(m.stackShare, 1)
  assert.equal(m.worstStackPay, 0)
  assert.equal(m.medianLowestInStack, 0)
  assert.equal(m.hiddenLowPayRate, 1)
})

test('without stacks there is no pay inside one', () => {
  const m = run(day(0, 12), 'greedy')
  assert.equal(m.stackShare, 0)
  for (const k of ['worstStackPay', 'medianLowestInStack', 'hiddenLowPayRate'] as const) assert.ok(Number.isNaN(m[k]), k)
})

test('sweep: days without stacks do not pull the stack figures down', () => {
  const spec = { id: 'optimizer', batch: 1, fresh: 0.5, pay: 0 } as const
  const stacked = runSweep(() => day(3, 12), spec, DEFAULT_CONFIG, 1, 1)[0].metrics
  assert.equal(stacked.worstStackPay, 3)
  const mixed = runSweep(d => d ? day(9) : day(3, 12), spec, DEFAULT_CONFIG, 1, 3)[0].metrics
  for (const k of ['worstStackPay', 'medianLowestInStack', 'hiddenLowPayRate'] as const) assert.equal(mixed[k], stacked[k], k)
})
