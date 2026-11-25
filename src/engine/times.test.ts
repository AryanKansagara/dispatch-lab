import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDataset, parseTime } from './data.ts'

test('only documented time formats parse', () => {
  for (const s of ['4,5', 'abc 5', 'order 12', '+5 pm', '5 May', '99:99', '25:10', '24:00', '12:60', '12:30:60', '2024-02-31', '2024-02-31T10:00', '2024-13-01', '2023-02-29T10:00Z',
    '2024-03-02T25:00Z', '2024-03-02T10:60Z', '2024-03-02T10:00+15:00', '2024-03-02T10:00:00Zzz', '3/2/2024 18:05', '1.5.2024', 'nope', '']) assert.ok(Number.isNaN(parseTime(s)), s)
})

test('timestamps in every documented shape are the same instant', () => {
  // 2024-03-02 18:05 UTC is 1,709,402,700 s.
  const want = 1_709_402_700 / 60
  for (const s of ['2024-03-02T18:05:00Z', '2024-03-02 18:05:00Z', '2024-03-02T18:05Z', '2024-03-02T18:05:00.000Z', '2024-03-02T13:05:00-05:00', '2024-03-02T23:35+0530', '2024-03-02 20:05:00+02', '2024-03-02 18:05:00 UTC',
    '2024-03-02T18:05:00.000000+00:00', '2024-3-2 18:05Z', '1709402700', '1709402700000']) assert.equal(parseTime(s), want, s)
  assert.equal(parseTime('2024-03-02T18:05:30Z'), want + 0.5)
  assert.equal(parseTime('2024-02-29'), Date.UTC(2024, 1, 29) / 60000)
  // No zone means this machine's zone, as the browser's own parser reads it.
  for (const s of ['2024-03-02T18:05', '2024-03-02 18:05:00', '2024/03/02 18:05']) assert.equal(parseTime(s), new Date(2024, 2, 2, 18, 5).getTime() / 60000, s)
  assert.equal(parseTime('18:05'), 1085)
  assert.equal(parseTime('00:00:30'), 0.5)
})

const dated = (...rows: [string, string][]) => parseDataset(
  ['order_date,created,store_lat,store_lng,customer_lat,customer_lng,prep', ...rows.map(([d, t]) => `${d},${t},40,-100,40.01,-100,10`)].join('\n'), '')

test('an unreadable date makes the time unknown instead of vanishing', () => {
  const p = dated(['3/19/2022', '18:00'], ['3/20/2022', '18:05'], ['3/21/2022', '18:06'])
  assert.equal(p.dataset, null)
  assert.equal(p.errors.filter(e => /bad date/.test(e)).length, 3)
  for (const d of ['31-02-2022', '2022-13-45', 'tomorrow', '2022-02-30']) assert.match(dated([d, '18:00']).errors.join(), /Order line 2: bad date/, d)
})

test('readable dates still order clock times, and a blank date on every row means none', () => {
  for (const [a, b] of [['19-03-2022', '20-03-2022'], ['2022-03-19', '2022-03-20'], ['19/03/2022', '20/03/2022'], ['2022-03-19 00:00:00', '2022-03-20 00:00:00']]) {
    assert.deepEqual(dated([a, '23:50'], [b, '00:10']).dataset!.orders.map(o => o.createdAt), [0, 20], a)
  }
  assert.deepEqual(dated(['', '18:00'], ['NaN', '18:05']).dataset!.orders.map(o => o.createdAt), [0, 5])
  // With a full timestamp the separate date adds nothing, so its spelling does not matter.
  assert.deepEqual(dated(['3/19/2022', '2022-03-19T18:00Z'], ['3/19/2022', '2022-03-19T18:05Z']).dataset!.orders.map(o => o.createdAt), [0, 5])
})
