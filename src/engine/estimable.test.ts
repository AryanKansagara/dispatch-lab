import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateCity } from './data.ts'
import { clusterRobustDiff, daysForPower, powerAt, runExperiment, welchDiff } from './experiment.ts'
import { DEFAULT_CONFIG } from './types.ts'

const row = (y: number, treated: boolean, cluster: string) => ({ y, treated, cluster })

test('with every unit in one arm there is no effect, interval, power or run length', () => {
  const e = clusterRobustDiff([row(30, true, 'a'), row(32, true, 'a'), row(34, true, 'b'), row(36, true, 'b')])
  assert.equal(e.why, 'empty-arm')
  for (const v of [e.diff, e.se, e.lo, e.hi, powerAt(1, e.se), daysForPower(1, e.se, 2)]) assert.ok(Number.isNaN(v))
})

test('an arm seen in one cluster gets a difference but no interval', () => {
  // Treated residuals inside the single treated cluster are -1 and +1: they cancel in its score.
  const e = clusterRobustDiff([row(9, true, 'a'), row(11, true, 'a'), row(4, false, 'b'), row(6, false, 'c')])
  assert.equal(e.diff, 5)
  assert.equal(e.why, 'few-clusters')
  assert.ok(Number.isNaN(e.se))
  assert.equal(clusterRobustDiff([row(1, true, 'a'), row(2, false, 'b')]).why, 'few-clusters')
})

test('an outcome that never varies does not prove anything with 100% power', () => {
  const e = clusterRobustDiff([row(0, true, 'a'), row(0, true, 'b'), row(0, false, 'a'), row(0, false, 'b')])
  assert.equal(e.why, 'no-variation')
  assert.equal(e.diff, 0)
  assert.equal(welchDiff([100, 100], [100, 100]).why, 'no-variation')
  assert.ok(Number.isNaN(powerAt(1, 0)))
})

test('a naive arm needs two orders for an interval', () => {
  assert.equal(welchDiff([], [1, 2]).why, 'empty-arm')
  assert.ok(Number.isNaN(welchDiff([], [1, 2]).diff))
  const e = welchDiff([1], [2, 4])
  assert.equal(e.diff, 2)
  assert.equal(e.why, 'few-clusters')
})

test('an estimable design keeps its numbers, worked by hand', () => {
  // Means 6 and 2. Residuals: a -2+(-1), b +2+1 with x - xBar = +-1/2, so scores are -1/2 and +1/2.
  const e = clusterRobustDiff([row(4, true, 'a'), row(8, true, 'b'), row(1, false, 'a'), row(3, false, 'b')])
  assert.equal(e.why, undefined)
  assert.equal(e.diff, 4)
  // G/(G-1) = 2, (n-1)/(n-2) = 1.5, meat = 0.5, sxx = 1.
  assert.ok(Math.abs(e.se - Math.sqrt(1.5)) < 1e-12)
})

test('two days, one region, two windows: the seed whose four units share an arm reports nothing', () => {
  const run = (seed: number, days: number, regionsPerSide: number) => runExperiment({
    makeDay: d => generateCity('lunch', seed, d), a: { id: 'greedy', batch: 0.5, fresh: 0.5, pay: 0 }, b: { id: 'batch', batch: 0.5, fresh: 0.5, pay: 0 },
    cfg: { ...DEFAULT_CONFIG, seed }, days, regionsPerSide, windowMin: 120, seed,
  }).outcomes.deliveryMin
  const bad = run(4, 2, 1)
  assert.equal(bad.switchback.why, 'empty-arm')
  assert.ok(Number.isNaN(bad.power) && Number.isNaN(bad.daysFor80) && Number.isNaN(bad.switchbackBias))
  assert.ok(Number.isFinite(bad.truth) && bad.naive.why === undefined)
  assert.equal(run(4, 3, 2).switchback.why, undefined)
})
