import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDataset } from './data.ts'

const q = (v: string) => `"${v.replaceAll('"', '""')}"`
const load = (f: { slat?: string; slng?: string; prep?: string; pay?: string }) => parseDataset(
  `id,created,store_lat,store_lng,customer_lat,customer_lng,prep,payout\na,1,${q(f.slat ?? '40')},${q(f.slng ?? '-74')},40,-74,${q(f.prep ?? '10')},${q(f.pay ?? '')}`, '')
const one = (f: Parameters<typeof load>[0]) => load(f).dataset?.orders[0]

test('payouts are read whole, with or without a currency', () => {
  for (const [cell, want] of [['$8.25', 8.25], ['8.25', 8.25], ['USD 8.25', 8.25], ['8.25 CAD', 8.25], ['CA$8.25', 8.25], ['€ 8.25', 8.25], ['1,250.50 CAD', 1250.5], ['.5', 0.5], ['0', 0], ['1e2', 100], ['$0.00', 0]] as const) {
    assert.equal(one({ pay: cell })?.payout, want, cell)
  }
  for (const cell of ['', 'NaN', 'null']) { assert.ok(one({ pay: cell })); assert.equal(one({ pay: cell })!.payout, undefined) }
})

test('payouts that cannot be read whole, or are negative, are reported and skipped', () => {
  for (const cell of ['8,25', '1,250', '-5', '-$5', 'N/A', '8.', '8.25-9', '8 25', '8.25 + tip', '(8.25)', '1e999', '=1+1']) {
    const p = load({ pay: cell })
    assert.equal(p.dataset, null, cell)
    assert.match(p.errors.join(), /Order line 2: bad payout/, cell)
  }
})

test('prep times are minutes, or hours and minutes, and never part of a cell', () => {
  for (const [cell, want] of [['12', 12], ['12 min', 12], ['(min) 24', 24], ['12.5 mins', 12.5], ['1h 20m', 80], ['2 h', 120], ['0', 0]] as const) assert.equal(one({ prep: cell })?.prepMin, want, cell)
  for (const cell of ['1,5 min', '10-15 min', '1e9', '1441', '-3', 'about 10', '00:15', '90 sec', '1h 20m 30s', '']) {
    assert.match(load({ prep: cell }).errors.join(), /bad prep time/, cell)
  }
})

test('an unreadable prep cell is not replaced by the pickup wait', () => {
  const p = parseDataset('created,picked_at,store_lat,store_lng,customer_lat,customer_lng,prep\n18:00,18:10,40,-74,40,-74,soon\n18:00,18:10,40,-74,40,-74,\n', '')
  assert.deepEqual(p.dataset!.orders.map(o => o.prepMin), [10])
  assert.match(p.errors.join(), /Order line 2: bad prep time/)
})

test('coordinates keep their hemisphere and are never cut to whole degrees', () => {
  for (const [cell, want] of [['-74', -74], ['74 W', -74], ['74.0° W', -74], ['74w', -74]] as const) assert.equal(one({ slng: cell })?.store.lng, want, cell)
  for (const [cell, want] of [['40 N', 40], ['40.0°', 40]] as const) assert.equal(one({ slat: cell })?.store.lat, want, cell)
  assert.equal(load({ slat: '40.0 S' }).dataset, null, 'the other hemisphere is over 50 km away')
  for (const cell of [`74°00'21" W`, '-74 W', '74,006', '74 N', 'W', '7 4', '74..0']) assert.match(load({ slng: cell }).errors.join(), /bad store lat\/lng/, cell)
})

test('unreadable recorded delivery times are counted', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `${i},40,-74,40,-74,10,${i < 2 ? 'late' : `(min) ${20 + i}`}`)
  const p = parseDataset(['created,store_lat,store_lng,customer_lat,customer_lng,prep,Time_taken(min)', ...rows].join('\n'), '')
  assert.equal(p.dataset!.observed!.n, 10)
  assert.match(p.warnings.join(), /could not be read and were left out: 2\./)
})
