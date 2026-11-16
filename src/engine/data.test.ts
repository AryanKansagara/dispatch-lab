import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isMeituan, MAX_ORDERS, parseDataset, parseTime, sliceMeituan } from './data.ts'
import { t975 } from './experiment.ts'
import { computeMetrics } from './metrics.ts'
import { simulate } from './sim.ts'
import { makeStrategy } from './strategies.ts'
import { DEFAULT_CONFIG } from './types.ts'

// Both fixtures copy the real column layout and quirks of the public files with invented values,
// because neither source licence allows redistributing its rows.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const MEITUAN = fixture('meituan-waybills.csv')
const KAGGLE = fixture('kaggle-food-delivery.csv')

test('a Meituan waybill export loads as one area, with repeat offers merged and units converted', () => {
  assert.ok(isMeituan(MEITUAN))
  const p = parseDataset(MEITUAN, '')
  assert.deepEqual(p.errors, [])
  const d = p.dataset!
  assert.equal(d.name, 'Meituan waybills')
  // 46 orders in two areas, 10 turned-down offers repeated, 1 pre-booked: area 0 keeps 39.
  assert.equal(d.orders.length, 39)
  assert.equal(new Set(d.orders.map(o => o.id)).size, 39)
  assert.ok(!d.orders.some(o => o.id === '7'), 'pre-booked order skipped')
  assert.ok(d.orders.every(o => Math.abs(o.store.lat - 45.87) < 0.02 && Math.abs(o.store.lng - 174.56) < 0.02), 'degrees times 1e6 divided back')
  // 11:00 China time is minute 0, and Unix seconds became minutes.
  assert.equal(d.startHour, 11)
  assert.equal(d.orders[0].createdAt, 0)
  assert.equal(d.orders[1].createdAt, 1.5)
  assert.match(p.warnings.join('|'), /area 0 on 20221017.*2 area-days/)
  assert.match(p.warnings.join('|'), /10 repeat offers merged/)
})

test('Meituan prep comes from the kitchen estimate, with a zero estimate given the median', () => {
  const d = parseDataset(MEITUAN, '').dataset!
  const zero = d.orders.find(o => o.id === '5')!
  const others = d.orders.filter(o => o.id !== '5').map(o => o.prepMin).sort((a, b) => a - b)
  assert.ok(others.every(p => p >= 7 && p <= 18), 'estimates are 7 to 18 minutes in the fixture')
  assert.equal(zero.prepMin, others[Math.floor(others.length / 2)])
  assert.match(parseDataset(MEITUAN, '').warnings.join('|'), /no usable kitchen estimate.*: 1\./)
})

test('Meituan couriers and recorded delivery times come from accepted offers only', () => {
  const d = parseDataset(MEITUAN, '').dataset!
  assert.equal(d.couriers.length, 9)
  assert.ok(d.couriers.every(c => c.id.startsWith('R1') && c.shiftEnd > c.shiftStart && c.shiftStart >= 0))
  assert.equal(d.observed!.n, 39)
  assert.ok(d.observed!.deliveryP50 > 17 && d.observed!.deliveryP90 <= 43)
  const m = computeMetrics(simulate(d, makeStrategy({ id: 'optimizer', batch: 0.5, fresh: 0.5, pay: 0 }), DEFAULT_CONFIG))
  assert.equal(m.delivered, 39)
})

test('a Meituan file over the browser limit is cut to its busiest two hours', () => {
  const head = 'dt,order_id,courier_id,da_id,platform_order_time,sender_lat,sender_lng,recipient_lat,recipient_lng,estimate_meal_prepare_time'
  const base = 1665964800 // 08:00 China time
  const rows: string[] = []
  // 3,000 orders an hour from 08:00 to 10:00 local, then 2,000 at 10:00: the first two hours are busiest but too big.
  for (let i = 0; i < 8000; i++) {
    const t = i < 6000 ? base + Math.floor(i * 1.2) : base + 7200 + (i - 6000)
    rows.push(['20221017', i, 1, 0, t, 45870000, 174560000, 45880000, 174570000, t + 600].join(','))
  }
  const cut = sliceMeituan([head, ...rows].join('\n'))
  const kept = cut.text.split('\n').length - 1
  assert.equal(kept, 3000)
  assert.ok(kept <= MAX_ORDERS)
  assert.match(cut.note, /busiest hour from 08:00/)
  assert.equal(sliceMeituan(cut.text).text, cut.text, 'slicing is idempotent')
})

test('the Kaggle food delivery layout loads with its broken rows skipped and reported', () => {
  const p = parseDataset(KAGGLE, '')
  const d = p.dataset!
  // NaN order time is reported by line; flipped-sign and 0,0 restaurants fail the 50 km rule;
  // the lone Bangalore order is a different market.
  assert.match(p.errors.join('|'), /Order line 5: bad created time/)
  assert.match(p.warnings.join('|'), /2 orders skipped with the store over 50 km/)
  assert.match(p.warnings.join('|'), /several markets.*4 of 5 orders, around 26\.91, 75\.79/)
  assert.deepEqual(d.orders.map(o => o.id), ['0x1a01', '0x1a02', '0x1a05', '0x1a08'])
})

test('a separate date column orders clock times across midnight, and pickup time stands in for prep', () => {
  const d = parseDataset(KAGGLE, '').dataset!
  // 12 March 19:45, 20:10, 23:50, then 13 March 13:00.
  assert.deepEqual(d.orders.map(o => o.createdAt), [0, 25, 245, 1035])
  // Ordered 23:50, picked 00:05: fifteen minutes, not minus a day.
  assert.deepEqual(d.orders.map(o => o.prepMin), [10, 15, 15, 10])
})

test('epoch seconds and milliseconds are read as times, not as minutes', () => {
  assert.equal(parseTime('1665975600'), 1665975600 / 60)
  assert.equal(parseTime(1665975600000), 1665975600 / 60)
  assert.equal(parseTime('90'), 90)
  const p = parseDataset('created,store_lat,store_lng,customer_lat,customer_lng,prep\n1665975600,40,-100,40.01,-100,10\n1665976200,40,-100,40.01,-100,10', '')
  assert.deepEqual(p.dataset!.orders.map(o => o.createdAt), [0, 10])
})

test('a file spanning several days keeps its busiest day', () => {
  const rows = ['2024-03-01T12:00:00Z', '2024-03-02T12:00:00Z', '2024-03-02T12:30:00Z', '2024-03-02T18:00:00Z']
    .map((t, i) => `${i},${t},40,-100,40.01,-100,10`)
  const p = parseDataset(['id,created,store_lat,store_lng,customer_lat,customer_lng,prep', ...rows].join('\n'), '')
  assert.deepEqual(p.dataset!.orders.map(o => o.createdAt), [0, 30, 360])
  assert.match(p.warnings.join('|'), /2 days.*2024-03-02.*3 of 4/)
})

test('recorded delivery minutes are summarised beside the simulation', () => {
  const rows = Array.from({ length: 20 }, (_, i) => `${i},40,-100,40.01,-100,10,${20 + i}`)
  const d = parseDataset(['created,store_lat,store_lng,customer_lat,customer_lng,prep,delivery_min', ...rows].join('\n'), '').dataset!
  assert.deepEqual(d.observed, { deliveryP50: 29.5, deliveryP90: 37.1, n: 20 })
})

test('t critical values match the table at few clusters, where switchbacks often sit', () => {
  for (const [df, t] of [[1, 12.706], [2, 4.303], [3, 3.182], [5, 2.571], [10, 2.228], [11, 2.201], [20, 2.086], [60, 2.0]] as const) {
    assert.ok(Math.abs(t975(df) - t) < 0.004, `df ${df}: ${t975(df)} vs ${t}`)
  }
})
