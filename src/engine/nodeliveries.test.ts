import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeMetrics } from './metrics.ts'
import { simulate } from './sim.ts'
import { makeStrategy } from './strategies.ts'
import { runSweep } from './sweep.ts'
import { DEFAULT_CONFIG, type Dataset } from './types.ts'

const at = (lat: number) => ({ lat, lng: 20 })
/** One order a courier delivers, or, with a shift that ends before it, cannot. */
const day = (shiftEnd: number): Dataset => ({
  name: 'Test', synthetic: false,
  orders: [{ id: 'a', createdAt: 100, store: at(10), customer: at(10.01), prepMin: 10 }],
  couriers: [{ id: 'C1', shiftStart: 0, shiftEnd, start: at(10) }],
})
const greedy = makeStrategy({ id: 'greedy', batch: 0, fresh: 0.5, pay: 0 })
const optimizer = { id: 'optimizer', batch: 0.5, fresh: 0.5, pay: 0 } as const
const PER_DELIVERY = ['courierMinPerDelivery', 'milesPerDelivery', 'platformCost'] as const

test('a run without deliveries has no per-delivery figures, and no rate with nothing to divide by', () => {
  const m = computeMetrics(simulate(day(50), greedy, DEFAULT_CONFIG))
  assert.equal(m.delivered, 0)
  for (const k of [...PER_DELIVERY, 'payPerActiveHour', 'payPerMile'] as const) assert.ok(Number.isNaN(m[k]), k)
  // The courier was online and earned nothing: that is a figure.
  assert.equal(m.payPerOnlineHour, 0)
  assert.equal(m.unfulfilledRate, 1)
})

test('a run with deliveries keeps its figures', () => {
  const m = computeMetrics(simulate(day(400), greedy, DEFAULT_CONFIG))
  assert.equal(m.delivered, 1)
  for (const k of [...PER_DELIVERY, 'payPerActiveHour', 'payPerOnlineHour', 'payPerMile'] as const) assert.ok(Number.isFinite(m[k]), k)
  assert.ok(m.courierMinPerDelivery > 0 && m.platformCost > 0)
})

test('sweep: days without deliveries are skipped, not averaged in as zeros', () => {
  const one = runSweep(() => day(400), optimizer, DEFAULT_CONFIG, 2, 1)
  const mixed = runSweep(d => day(d ? 50 : 400), optimizer, DEFAULT_CONFIG, 2, 3)
  mixed.forEach((p, i) => {
    for (const k of [...PER_DELIVERY, 'payPerActiveHour'] as const) assert.equal(p.metrics[k], one[i].metrics[k], k)
    // Food quality still counts the undelivered days.
    assert.ok(p.metrics.tempMean < one[i].metrics.tempMean)
    assert.ok(Math.abs(p.metrics.unfulfilledRate - 2 / 3) < 1e-9)
  })
  assert.ok(mixed.some(p => p.onFrontier))
})

test('sweep: a setting that delivers nothing is never on the frontier', () => {
  const none = runSweep(() => day(50), optimizer, DEFAULT_CONFIG, 3, 2)
  assert.ok(none.every(p => !p.onFrontier && Number.isNaN(p.metrics.courierMinPerDelivery)))
  // Here only the lower batching weights deliver before the courier leaves.
  const short: Dataset = {
    name: 'Test', synthetic: false,
    orders: ['a', 'b'].map(id => ({ id, createdAt: 1, store: at(10.02), customer: at(10.03), prepMin: 5 })),
    couriers: [{ id: 'C1', shiftStart: 0, shiftEnd: 2, start: at(10) }],
  }
  const some = runSweep(() => short, optimizer, DEFAULT_CONFIG, 3, 1)
  assert.deepEqual(some.map(p => p.metrics.delivered > 0), [true, true, false])
  assert.deepEqual(some.map(p => p.onFrontier), [true, true, false])
})
