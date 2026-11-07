import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateCity, parseCsv, parseDataset, resampleDay, sampleCsv } from './data.ts'
import { clusterRobustDiff, daysForPower, normCdf, powerAt, regionIndexer, runExperiment, t975, welchDiff } from './experiment.ts'
import { FORBIDDEN, hungarian } from './hungarian.ts'
import { computeMetrics, paretoFront, quantile, TEMP, tempAt } from './metrics.ts'
import { bestInsertion, driveMin, EventQueue, haversineKm, rngFrom, simulate } from './sim.ts'
import { DEFAULT_SETTINGS, decodeSettings, encodeSettings, type Settings } from './settings.ts'
import { makeStrategy } from './strategies.ts'
import { runSweep } from './sweep.ts'
import { DEFAULT_CONFIG, type Dataset, type OrderState, type StrategyId, type StrategySpec } from './types.ts'

const spec = (id: StrategyId, batch = 0.5): StrategySpec => ({ id, batch, fresh: 0.5, pay: 0 })
const cfg = DEFAULT_CONFIG
const A = { lat: 40, lng: -100 }
const B = { lat: 40.02, lng: -100 }
const C = { lat: 40.02, lng: -99.98 }

test('haversine matches a known distance', () => {
  // One degree of latitude is about 111.2 km.
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.05)
  assert.equal(haversineKm(A, A), 0)
})

test('drive time scales with the road factor and speed', () => {
  const base = driveMin(A, B, cfg)
  assert.ok(Math.abs(driveMin(A, B, { ...cfg, roadFactor: cfg.roadFactor * 2 }) - base * 2) < 1e-9)
  assert.ok(Math.abs(driveMin(A, B, { ...cfg, speedKmh: cfg.speedKmh * 2 }) - base / 2) < 1e-9)
})

test('event queue pops in time order, ties in insertion order', () => {
  const q = new EventQueue<string>()
  q.push(5, 'c'); q.push(1, 'a'); q.push(5, 'd'); q.push(3, 'b')
  assert.deepEqual([q.pop()!.v, q.pop()!.v, q.pop()!.v, q.pop()!.v], ['a', 'b', 'c', 'd'])
  assert.equal(q.pop(), undefined)
})

test('hungarian finds the brute-force optimum on random rectangles', () => {
  const r = rngFrom(11)
  const best = (m: number[][], row: number, used: Set<number>): number => {
    if (row === m.length) return 0
    let b = Infinity
    for (let c = 0; c < m[0].length; c++) {
      if (used.has(c)) continue
      used.add(c)
      b = Math.min(b, m[row][c] + best(m, row + 1, used))
      used.delete(c)
    }
    return b
  }
  for (let trial = 0; trial < 60; trial++) {
    const rows = 1 + Math.floor(r() * 5)
    const cols = rows + Math.floor(r() * 3)
    const m = Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.floor(r() * 50)))
    const match = hungarian(m)
    assert.equal(new Set(match).size, rows)
    assert.equal(match.reduce((s, c, i) => s + m[i][c], 0), best(m, 0, new Set()))
  }
})

test('hungarian handles more rows than columns and forbidden cells', () => {
  const wide = hungarian([[1], [5], [3]])
  assert.deepEqual(wide, [0, -1, -1])
  assert.deepEqual(hungarian([[FORBIDDEN, 2], [FORBIDDEN, 1]]), [-1, 1])
  assert.deepEqual(hungarian([]), [])
})

function oneOrder(prepMin: number, couriers = 1): Dataset {
  return {
    name: 't', synthetic: true,
    orders: [{ id: 'o', createdAt: 0, store: A, customer: B, prepMin, tip: 3 }],
    couriers: Array.from({ length: couriers }, (_, i) => ({ id: `c${i}`, shiftStart: 0, shiftEnd: 300, start: A })),
  }
}

test('one order runs the exact lifecycle with arithmetic that can be checked by hand', () => {
  const r = simulate(oneOrder(10), makeStrategy(spec('greedy')), cfg)
  const o = r.orders[0]
  assert.equal(o.assignedAt, 0)
  // Courier is already at the store, waits for the 10 minute prep, then a 2 minute pickup.
  assert.ok(Math.abs(o.pickedAt - 12) < 1e-9)
  assert.ok(Math.abs(o.deliveredAt - (12 + driveMin(A, B, cfg) + cfg.dropoffMin)) < 1e-9)
  assert.equal(r.couriers[0].legs[0].kind, 'wait')
  assert.equal(r.couriers[0].load, 0)
})

test('prep runs late: the courier waits on the true ready time, not the forecast', () => {
  const d = oneOrder(20)
  d.orders[0].prepEstMin = 5
  const r = simulate(d, makeStrategy(spec('greedy')), cfg)
  assert.ok(Math.abs(r.orders[0].pickedAt - 22) < 1e-9)
})

test('runs are deterministic for a seed and differ across seeds', () => {
  const run = (seed: number) => computeMetrics(simulate(generateCity('lunch', seed), makeStrategy(spec('optimizer')), cfg))
  assert.deepEqual(run(4), run(4))
  assert.notEqual(run(4).deliveryP50, run(5).deliveryP50)
})

for (const id of ['greedy', 'batch', 'hungarian', 'optimizer'] as StrategyId[]) {
  test(`${id}: every order is conserved and every timeline is ordered`, () => {
    const r = simulate(generateCity('lunch', 2), makeStrategy(spec(id)), cfg)
    const m = computeMetrics(r)
    assert.ok(m.delivered > 0)
    assert.equal(m.delivered, r.orders.filter(o => o.deliveredAt >= 0).length)
    for (const o of r.orders) {
      if (o.deliveredAt < 0) continue
      assert.ok(o.assignedAt >= o.createdAt - 1e-9, 'assigned after created')
      assert.ok(o.pickedAt >= o.assignedAt, 'picked after assigned')
      assert.ok(o.pickedAt >= o.readyAt - 1e-9, 'never picked before ready')
      assert.ok(o.deliveredAt > o.pickedAt, 'delivered after picked')
    }
    for (const c of r.couriers) {
      for (let i = 1; i < c.legs.length; i++) assert.ok(c.legs[i].t0 >= c.legs[i - 1].t1 - 1e-6, 'legs do not overlap')
    }
  })
}

test('greedy and global assignment never stack; batching at the store does', () => {
  const d = generateCity('dinner', 1)
  assert.equal(computeMetrics(simulate(d, makeStrategy(spec('greedy')), cfg)).stackShare, 0)
  assert.equal(computeMetrics(simulate(d, makeStrategy(spec('hungarian')), cfg)).stackShare, 0)
  assert.ok(computeMetrics(simulate(d, makeStrategy(spec('batch')), cfg)).stackShare > 0.1)
})

test('a batching strategy never carries more than the stack limit', () => {
  const r = simulate(generateCity('dinner', 1), makeStrategy(spec('optimizer', 1)), { ...cfg, maxStack: 2 })
  const byCourier = new Map<number, OrderState[]>()
  for (const o of r.orders) if (o.pickedAt >= 0) byCourier.set(o.courier, [...(byCourier.get(o.courier) ?? []), o])
  for (const list of byCourier.values()) {
    for (const o of list) {
      const inBag = list.filter(x => x.pickedAt <= o.pickedAt && (x.deliveredAt < 0 || x.deliveredAt > o.pickedAt)).length
      assert.ok(inBag <= 2, `carried ${inBag}`)
    }
  }
})

test('the batching slider buys efficiency with food quality, on average across days', () => {
  const at = (batch: number) => [1, 2, 3].map(seed => computeMetrics(simulate(generateCity('dinner', seed), makeStrategy(spec('optimizer', batch)), cfg)))
  const avg = (rows: ReturnType<typeof computeMetrics>[], f: (m: ReturnType<typeof computeMetrics>) => number) => rows.reduce((s, m) => s + f(m), 0) / rows.length
  const low = at(0.1)
  const high = at(1)
  assert.ok(avg(high, m => m.stackShare) > avg(low, m => m.stackShare) + 0.25, 'more stacks')
  assert.ok(avg(high, m => m.courierMinPerDelivery) < avg(low, m => m.courierMinPerDelivery), 'fewer courier minutes')
  assert.ok(avg(high, m => m.tempMean) < avg(low, m => m.tempMean), 'colder food')
  assert.ok(avg(high, m => m.payPerActiveHour) > avg(low, m => m.payPerActiveHour), 'more pay per active hour')
})

test('low batching does not strand orders when idle couriers exist', () => {
  const m = computeMetrics(simulate(generateCity('dinner', 1), makeStrategy(spec('optimizer', 0)), cfg))
  assert.ok(m.deliveryP90 < 80, `p90 ${m.deliveryP90}`)
  assert.equal(m.unfulfilledRate, 0)
})

test('insertion keeps pickup before dropoff and finds the cheap same-store stack', () => {
  const o = (index: number, store = A, customer = B): OrderState => ({
    index, src: { id: `${index}`, createdAt: 0, store, customer, prepMin: 0 }, createdAt: 0, readyAt: 0, readyEst: 0, promiseAt: 60,
    soloMin: 0, assignedAt: 0, pickedAt: -1, deliveredAt: -1, courier: 0, stackId: -1, pay: 0, basePaid: 0, tip: 0, marginalMiles: 0,
  })
  const orders = [o(0), o(1)]
  const existing = [{ kind: 'pickup', order: 0, ...A }, { kind: 'dropoff', order: 0, ...B }] as const
  const q = bestInsertion(A, 0, [...existing], orders[1], orders, cfg)
  assert.ok(q.route.findIndex(s => s.order === 1 && s.kind === 'pickup') < q.route.findIndex(s => s.order === 1 && s.kind === 'dropoff'))
  assert.ok(q.addedMiles < 0.01, 'same store, same customer adds no road')
  assert.ok(q.addedMin < 3, 'adds only handling time')
})

test('a cheap stacked order earns the base floor: the hidden low-pay mechanism', () => {
  const data: Dataset = {
    name: 't', synthetic: true,
    orders: [
      { id: 'far', createdAt: 0, store: A, customer: C, prepMin: 5, tip: 6 },
      { id: 'cheap', createdAt: 0, store: A, customer: C, prepMin: 5, tip: 0 },
    ],
    couriers: [{ id: 'c', shiftStart: 0, shiftEnd: 200, start: A }],
  }
  const r = simulate(data, makeStrategy(spec('batch')), cfg)
  const m = computeMetrics(r)
  assert.equal(m.stackShare, 1)
  assert.equal(r.orders[0].stackId, r.orders[1].stackId)
  assert.equal(m.worstStackPay, cfg.minBase)
  assert.equal(m.hiddenLowPayRate, 1)
  assert.ok(r.orders[0].pay > r.orders[1].pay * 3, 'the offer total hides the gap')
})

test('uploaded payout is honored instead of the pay model', () => {
  const d = oneOrder(0)
  d.orders[0].payout = 9.25
  const r = simulate(d, makeStrategy(spec('greedy')), cfg)
  assert.equal(r.orders[0].pay, 9.25)
  assert.equal(r.couriers[0].pay, 9.25)
})

test('food stays hot until ready, then cools more slowly in the bag than on the shelf', () => {
  assert.equal(tempAt({ readyAt: 10, pickedAt: -1 }, 5), TEMP.hotC)
  const shelf = tempAt({ readyAt: 0, pickedAt: -1 }, 20)
  const bag = tempAt({ readyAt: 0, pickedAt: 0 }, 20)
  assert.ok(bag > shelf && shelf < TEMP.hotC)
  assert.ok(Math.abs(shelf - (TEMP.ambientC + (TEMP.hotC - TEMP.ambientC) * Math.exp(-TEMP.shelfK * 20))) < 1e-9)
  assert.ok(tempAt({ readyAt: 0, pickedAt: -1 }, 1e4) - TEMP.ambientC < 1e-6)
})

test('an undelivered order counts as late and cold rather than vanishing', () => {
  const d = oneOrder(5)
  d.couriers = []
  const m = computeMetrics(simulate(d, makeStrategy(spec('greedy')), cfg))
  assert.equal(m.unfulfilledRate, 1)
  assert.equal(m.lateRate, 1)
  assert.equal(m.coldRate, 1)
})

test('quantile interpolates and pareto keeps only the undominated', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([], 0.5), 0)
  assert.deepEqual(paretoFront([[1, 1], [2, 2], [3, 1], [2, 2]]), [1, 2, 3])
})

test('statistics helpers match reference values', () => {
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-3)
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6)
  assert.ok(Math.abs(t975(10) - 2.228) < 0.01)
  assert.ok(Math.abs(t975(30) - 2.042) < 0.005)
  assert.ok(Math.abs(powerAt(2.801585, 1) - 0.8) < 0.005)
  assert.equal(daysForPower(0, 1, 5), Infinity)
  // Halving the detectable effect quadruples the run length.
  assert.equal(daysForPower(1, 1, 4) / daysForPower(2, 1, 4), 4)
})

test('cluster-robust SE exceeds the naive SE when errors move together within clusters', () => {
  const r = rngFrom(3)
  const rows: { y: number; treated: boolean; cluster: string }[] = []
  const treatedY: number[] = []
  const controlY: number[] = []
  for (let g = 0; g < 12; g++) {
    const shock = (r() - 0.5) * 6
    // Whole clusters are treated, so a cluster shock looks like a treatment effect.
    const treated = g % 2 === 0
    for (let i = 0; i < 40; i++) {
      const y = shock + (r() - 0.5)
      rows.push({ y, treated, cluster: `g${g}` })
      ;(treated ? treatedY : controlY).push(y)
    }
  }
  const robust = clusterRobustDiff(rows)
  const naive = welchDiff(controlY, treatedY)
  assert.ok(robust.se > naive.se * 3, `${robust.se} vs ${naive.se}`)
  assert.equal(robust.clusters, 12)
  assert.ok(Math.abs(robust.diff - naive.diff) < 1e-9, 'same point estimate')
})

test('difference in means is exact on a hand-made table', () => {
  const e = clusterRobustDiff([
    { y: 1, treated: false, cluster: 'a' }, { y: 3, treated: false, cluster: 'b' },
    { y: 4, treated: true, cluster: 'c' }, { y: 8, treated: true, cluster: 'd' },
  ])
  assert.equal(e.diff, 4)
  assert.ok(e.lo < 4 && e.hi > 4)
})

test('regions split store volume evenly', () => {
  const d = generateCity('dinner', 1)
  const regionOf = regionIndexer(d, 2)
  const counts = [0, 0, 0, 0]
  d.orders.forEach(o => counts[regionOf(o)]++)
  assert.ok(counts.every(c => c > 0))
})

test('A/A switchback: identical strategies give a CI that covers zero', () => {
  const r = runExperiment({ makeDay: d => generateCity('lunch', 2, d), a: spec('greedy'), b: spec('greedy'), cfg, days: 3, regionsPerSide: 2, windowMin: 30, seed: 1 })
  const o = r.outcomes.deliveryMin
  assert.equal(o.truth, 0, 'same days and same strategy have identical global results')
  assert.ok(o.switchback.lo <= 0 && o.switchback.hi >= 0, `${o.switchback.lo}..${o.switchback.hi}`)
})

test('interference: a shared fleet makes naive A/B understate the harm of heavy stacking', () => {
  const r = runExperiment({ makeDay: d => generateCity('dinner', 3, d), a: spec('hungarian'), b: spec('optimizer', 0.5), cfg, days: 4, regionsPerSide: 2, windowMin: 30, seed: 3 })
  const o = r.outcomes.deliveryMin
  assert.ok(o.truth > 0, 'stacking slows delivery when run citywide')
  assert.ok(Math.abs(o.naiveBias) > Math.abs(o.switchbackBias), `naive ${o.naiveBias} vs switchback ${o.switchbackBias}`)
  assert.ok(r.units > 0 && r.grid.length > 0)
  assert.ok(r.grid.some(c => c.treated) && r.grid.some(c => !c.treated), 'both arms randomized')
})

test('sweep walks the slider and marks a frontier', () => {
  const pts = runSweep(d => generateCity('lunch', 1, d), spec('optimizer'), cfg, 5, 1)
  assert.deepEqual(pts.map(p => p.batch), [0, 0.25, 0.5, 0.75, 1])
  assert.ok(pts.some(p => p.onFrontier))
})

test('csv parser handles quotes, commas and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x,1","he said ""hi"""\n\n3,4'), [['a', 'b'], ['x,1', 'he said "hi"'], ['3', '4']])
})

test('sample csv round-trips into a dataset that runs', () => {
  const s = sampleCsv()
  const p = parseDataset(s.orders, s.couriers)
  assert.deepEqual(p.errors, [])
  assert.equal(p.dataset!.orders.length, 120)
  assert.equal(p.dataset!.couriers.length, 20)
  assert.equal(p.dataset!.synthetic, false)
  const m = computeMetrics(simulate(p.dataset!, makeStrategy(spec('optimizer')), cfg))
  assert.ok(m.delivered > 0)
  assert.equal(simulate(p.dataset!, makeStrategy(spec('greedy')), cfg).orders[0].pay, p.dataset!.orders[0].payout)
})

test('json input, clock times and an auto fleet all work', () => {
  const json = JSON.stringify({
    orders: [
      { id: 'a', created: '18:05', storeLat: 40, storeLng: -100, customerLat: 40.01, customerLng: -100, prep: 10 },
      { id: 'b', created: '18:30', storeLat: 40, storeLng: -100, customerLat: 40.01, customerLng: -100.01, prep: 8, payout: 7 },
    ],
  })
  const p = parseDataset(json, '')
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.dataset!.orders.map(o => o.createdAt), [0, 25])
  assert.equal(p.dataset!.orders[1].payout, 7)
  assert.equal(p.dataset!.orders[0].payout, undefined)
  assert.match(p.warnings.join(), /assumed fleet/)
})

test('bad rows are reported by line and good rows survive', () => {
  const p = parseDataset(
    'created,store_lat,store_lng,customer_lat,customer_lng,prep\n1,40,-100,40.1,-100,10\nnope,40,-100,40.1,-100,10\n3,400,-100,40.1,-100,10',
    'shift_start,shift_end,start_lat,start_lng\n0,100,40,-100\n90,10,40,-100',
  )
  assert.equal(p.dataset!.orders.length, 1)
  assert.equal(p.dataset!.couriers.length, 1)
  assert.match(p.errors.join('|'), /Order line 3/)
  assert.match(p.errors.join('|'), /Order line 4: coordinates/)
  assert.match(p.errors.join('|'), /Courier line 3/)
})

test('garbage input fails with a message, never a throw', () => {
  assert.equal(parseDataset('{not json', '').errors.length, 1)
  assert.ok(parseDataset('', '').errors.length > 0)
  assert.ok(parseDataset('{"orders": 3}', '').errors.length > 0)
  assert.equal(parseDataset('a,b\n1,2', '').dataset, null)
})

test('resampled days keep the fleet and order count, and vary the demand', () => {
  const base = parseDataset(sampleCsv().orders, sampleCsv().couriers).dataset!
  const a = resampleDay(base, 1)
  assert.equal(a.orders.length, base.orders.length)
  assert.equal(a.couriers, base.couriers)
  assert.notDeepEqual(a.orders.map(o => o.createdAt), resampleDay(base, 2).orders.map(o => o.createdAt))
})

test('one city keeps its stores across days and changes them across seeds', () => {
  const stores = (seed: number, day: number) => new Set(generateCity('lunch', seed, day).orders.map(o => o.store.lat))
  const a = stores(1, 0)
  assert.ok([...stores(1, 1)].some(x => a.has(x)))
  assert.ok(![...stores(2, 0)].some(x => a.has(x)))
})

test('settings survive a URL round trip', () => {
  const s: Settings = { ...DEFAULT_SETTINGS, scenario: 'rain', seed: 42, a: { id: 'batch', batch: 0.3, fresh: 0.7, pay: 0.2 }, compare: false, tab: 'sweep', windowMin: 60 }
  assert.deepEqual(decodeSettings(encodeSettings(s)), s)
})

test('a hostile or broken share link falls back to safe values', () => {
  const s = decodeSettings('#s=__proto__&seed=NaN&a=rm.1.2.3&stack=999&speed=-4&tab=nope&days=1e9')
  assert.equal(s.scenario, DEFAULT_SETTINGS.scenario)
  assert.equal(s.seed, DEFAULT_SETTINGS.seed)
  assert.deepEqual(s.a, DEFAULT_SETTINGS.a)
  assert.equal(s.maxStack, 4)
  assert.equal(s.speedKmh, 5)
  assert.equal(s.tab, DEFAULT_SETTINGS.tab)
  assert.equal(s.days, 30)
  assert.equal(decodeSettings('#a=greedy.900.-5.x').a.batch, 1)
  assert.equal(decodeSettings('#a=greedy.900.-5.x').a.fresh, 0)
})
