import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRunnable, parseDataset, sampleCsv } from './data.ts'

const orders = (...times: string[]) => ['id,created,store_lat,store_lng,customer_lat,customer_lng,prep', ...times.map((t, i) => `o${i},${t},40,-100,40.01,-100,10`)].join('\n')
const couriers = (...shifts: string[]) => ['shift_start,shift_end,lat,lng', ...shifts.map(s => `${s},40,-100`)].join('\n')
const ISO = '2024-03-02T18:00:00Z'

test('orders and couriers on different kinds of time are refused, naming both', () => {
  const cases: [string, string, RegExp][] = [
    [ISO, '17:00,23:00', /dated times.*clock times/],
    [ISO, '0,240', /dated times.*plain minutes/],
    ['18:00', '0,240', /clock times.*plain minutes/],
    ['5', '17:00,23:00', /plain minutes.*clock times/],
    ['5', '1709402400,1709409600', /plain minutes.*dated times/],
  ]
  for (const [o, c, message] of cases) {
    const p = parseDataset(orders(o), couriers(c))
    assert.equal(p.dataset, null)
    assert.match(p.errors[0], message)
  }
})

test('one odd cell is reported by line and the rest still load', () => {
  const p = parseDataset(orders('5', '6', '18:00', '7'), couriers('0,90', '0,1709402400000', '0,20000'))
  assert.equal(p.dataset!.orders.length, 3)
  assert.equal(p.dataset!.couriers.length, 1)
  assert.match(p.errors.join('|'), /Order line 4: created time is not in plain minutes/)
  assert.match(p.errors.join('|'), /Courier line 3: shift start and shift end are different kinds/)
  assert.match(p.errors.join('|'), /Courier line 4: the shift is longer than 7 days/)
  assert.equal(parseDataset(orders('5', '18:00'), '').dataset, null)
})

test('a clock shift past midnight ends the next day, with its late orders', () => {
  const p = parseDataset(orders('23:50', '00:10'), couriers('18:00,02:00'))
  assert.deepEqual(p.errors, [])
  // Minute 0 is 18:00: 23:50 is 350, 00:10 the next day is 370, the shift is 8 hours.
  assert.deepEqual(p.dataset!.orders.map(o => o.createdAt), [350, 370])
  assert.deepEqual([p.dataset!.couriers[0].shiftStart, p.dataset!.couriers[0].shiftEnd], [0, 480])
  assert.match(p.warnings.join('|'), /next day: 1\./)
  // Lunch orders stay where a day shift covers them.
  const day = parseDataset(orders('12:00', '23:50'), couriers('11:00,15:00', '18:00,02:00'))
  assert.deepEqual(day.dataset!.orders.map(o => o.createdAt), [60, 770])
})

test('couriers who were supplied are never replaced by an invented fleet', () => {
  for (const c of [couriers('90,10'), couriers('a,b'), couriers('50000,50100')]) {
    const p = parseDataset(orders('1', '2'), c)
    assert.equal(p.dataset, null, c)
    assert.match(p.errors[0], /clear that box to use an assumed fleet/)
  }
  // The day cut keeps 2 March; the only courier worked on the 8th.
  const p = parseDataset(orders('2024-03-01T12:00:00Z', ISO, '2024-03-02T19:00:00Z'), couriers('2024-03-08T12:00:00Z,2024-03-08T18:00:00Z'))
  assert.match(p.errors[0], /No courier works/)
  assert.match(parseDataset(orders('1'), '').warnings.join('|'), /No couriers supplied/)
})

test('a run is never longer than its shifts allow', () => {
  const p = parseDataset(orders('2024-03-02T18:00:00Z', '2024-03-02T18:05:00Z'), couriers('2024-03-02T17:00:00Z,2024-03-02T23:00:00Z', '2023-03-02T17:00:00Z,2023-03-02T23:00:00Z'))
  assert.equal(p.dataset!.couriers.length, 1)
  assert.deepEqual(p.dataset!.orders.map(o => o.createdAt), [60, 65])
  assert.match(p.warnings.join('|'), /more than a day from every order.*: 1\./)
})

test('a saved dataset is only reused when it can run', () => {
  const s = sampleCsv()
  const d = parseDataset(s.orders, s.couriers).dataset!
  assert.ok(isRunnable(JSON.parse(JSON.stringify(d))))
  for (const x of [null, {}, [], 3, { ...d, orders: [] }, { ...d, orders: [null] }, { ...d, couriers: null },
    { ...d, orders: [{ ...d.orders[0], createdAt: 28_489_020 }] }, { ...d, orders: [{ ...d.orders[0], store: undefined }] }]) assert.equal(isRunnable(x), false)
})
