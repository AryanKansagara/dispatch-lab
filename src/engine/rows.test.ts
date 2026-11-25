import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseCsv, parseDataset } from './data.ts'

const HEAD = 'id,created,store_lat,store_lng,customer_lat,customer_lng,prep'
const row = (id: string, t = 1) => `${id},${t},40,-100,40.01,-100,10`
const FLEET = 'shift_start,shift_end,lat,lng\n0,90,40,-100'

test('a quote that never closes is an error with its line, and loads nothing', () => {
  const p = parseDataset([HEAD, row('a'), row('"b'), row('c'), row('d')].join('\n'), '')
  assert.equal(p.dataset, null)
  assert.match(p.errors.join(), /Orders: a quote opened on line 3 is never closed/)
  assert.match(parseDataset([HEAD, row('a')].join('\n'), `${FLEET}\n"0,90,40,-100`).errors.join(), /Couriers: a quote opened on line 3/)
})

test('a quote that closes inside a later row is an error too, not a merged row', () => {
  const p = parseDataset([HEAD, row('"a'), row('b"x'), row('c')].join('\n'), '')
  assert.equal(p.dataset, null)
  assert.match(p.errors.join(), /quote opened on line 2 closes in the middle of a cell on line 3/)
})

test('an inch mark inside a cell is text and every row loads', () => {
  const p = parseDataset([HEAD, row('a'), row('b "x'), row('5" sub'), row('d')].join('\n'), FLEET)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.dataset!.orders.map(o => o.id), ['a', 'b "x', '5" sub', 'd'])
})

test('RFC 4180 quoting, CRLF, BOM, blank lines and trailing commas still work', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n\r\n"two\r\nlines", "spaced" \r\n"",\r3,4'), [['a', 'b'], ['x,1', 'he said "hi"'], ['two\r\nlines', 'spaced '], ['3', '4']])
  const p = parseDataset(`﻿${HEAD}\r\n${row('a')},\r\n\r\n${row('"b,1"')},,\r\n`, FLEET)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.dataset!.orders.map(o => o.id), ['a', 'b,1'])
})

test('surplus values are reported, for orders and couriers', () => {
  const p = parseDataset([`${HEAD},payout`, `${row('a')},8,25`, `${row('b')},8.25`].join('\n'), `${FLEET}\n0,90,40,5,-100`)
  assert.deepEqual(p.dataset!.orders.map(o => o.payout), [8.25])
  assert.equal(p.dataset!.couriers.length, 1)
  assert.match(p.errors.join('|'), /Order line 2: 9 values for 8 columns.*Courier line 3: 5 values for 4 columns/)
})

test('JSON entries that are not objects are reported, never a throw', () => {
  const good = { id: 'a', created: 1, storeLat: 40, storeLng: -100, customerLat: 40.01, customerLng: -100, prep: 10 }
  for (const bad of [null, 1, 'x', true, [1, 2]]) {
    assert.match(parseDataset(JSON.stringify([bad]), '').errors.join(), /Order line 2: not an object/)
    assert.match(parseDataset(JSON.stringify({ orders: [good], couriers: [bad] }), '').errors.join(), /Courier line 2: not an object/)
    assert.equal(parseDataset(JSON.stringify([good, bad]), '').dataset!.orders.length, 1)
  }
})

test('a cut-off Meituan row is counted', () => {
  const text = readFileSync(new URL('./fixtures/meituan-waybills.csv', import.meta.url), 'utf8').trimEnd()
  const lines = text.split('\n')
  // Cut every row of one area-0 order down to its area column, so its time and places are gone.
  const head = lines[0].split(',')
  const area = head.indexOf('da_id')
  const cut = lines.findIndex((l, i) => i > 0 && l.split(',')[area] === '0')
  const keep = Math.max(...['dt', 'order_id', 'courier_id', 'da_id'].map(c => head.indexOf(c))) + 1
  const id = lines[cut].split(',')[head.indexOf('order_id')]
  const p = parseDataset(lines.map((l, i) => i && l.split(',')[head.indexOf('order_id')] === id ? l.split(',').slice(0, keep).join(',') : l).join('\n'), '')
  assert.ok(!p.dataset!.orders.some(o => o.id === id))
  assert.match(p.warnings.join(), /no readable order time, store or customer: 1\./)
})
