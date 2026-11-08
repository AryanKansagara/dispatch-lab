import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { addressPoints, cityFromOverpass, parseCityKey, PRESETS, searchedKey, type CityGeo } from './city.ts'
import { generateCity } from './data.ts'

const C = { lat: 43.65, lng: -79.38 }
const street = (dLat: number, hw = 'residential') => ({ type: 'way', tags: { highway: hw }, geometry: [-0.01, 0, 0.01].map(d => ({ lat: C.lat + dLat, lon: C.lng + d })) })
// A north-south avenue through every street's west end, so the grid is one connected network.
const avenue = { type: 'way', tags: { highway: 'secondary' }, geometry: Array.from({ length: 30 }, (_, i) => ({ lat: C.lat + (i - 15) * 0.001, lon: C.lng - 0.01 })) }
const fixture = (stores: number) => ({
  elements: [
    ...Array.from({ length: stores }, (_, i) => ({ type: 'node', lat: C.lat + i * 0.0005, lon: C.lng, tags: { amenity: i % 3 ? 'restaurant' : 'fast_food' } })),
    { type: 'node', lat: C.lat, lon: C.lng, tags: { amenity: 'restaurant' } }, // duplicate position
    { type: 'node', lat: C.lat + 0.5, lon: C.lng, tags: { amenity: 'cafe' } }, // 55 km away
    { type: 'way', center: { lat: C.lat - 0.001, lon: C.lng }, tags: { amenity: 'cafe' } },
    ...Array.from({ length: 30 }, (_, i) => street((i - 15) * 0.001, i % 10 ? 'residential' : 'primary')),
    avenue,
    { type: 'way', tags: { highway: 'residential' }, geometry: [{ lat: C.lat + 0.2, lon: C.lng }, { lat: C.lat + 0.2, lon: C.lng + 0.001 }] }, // island
    { type: 'way', tags: { leisure: 'park' }, geometry: [0, 1, 2, 3, 0].map(k => ({ lat: C.lat + (k % 2) * 0.002, lon: C.lng + (k > 1 ? 0.002 : 0) })) },
  ],
})

test('cityFromOverpass keeps nearby, de-duplicated restaurants and classifies streets', () => {
  const geo = cityFromOverpass(fixture(20), 'Test', C, 3)
  assert.equal(geo.stores.length, 21) // 20 + the way-centre cafe; duplicate and far one dropped
  assert.ok(geo.stores.every(([lat]) => Math.abs(lat - C.lat) < 0.03))
  assert.deepEqual(new Set(geo.streets.map(s => s.c)), new Set([0, 1, 2]))
  assert.equal(geo.streets.length, 31, 'the disconnected island street is dropped')
  assert.equal(geo.parks.length, 1)
})

test('cityFromOverpass refuses an area too thin to simulate', () => {
  assert.throws(() => cityFromOverpass(fixture(5), 'Hamlet', C, 3), /Only 6 restaurants/)
  assert.throws(() => cityFromOverpass({ nope: 1 }, 'X', C), /unexpected response/)
})

test('addressPoints spaces customers along local streets inside the radius', () => {
  const geo = cityFromOverpass(fixture(20), 'Test', C, 3)
  const pts = addressPoints(geo, 0.06)
  // 27 local streets of about 1.6 km each: roughly 26 points per street.
  assert.ok(pts.length > 27 * 20 && pts.length < 27 * 30, String(pts.length))
})

test('city keys round-trip and reject junk', () => {
  assert.equal(parseCityKey('toronto')?.kind, 'preset')
  assert.equal(parseCityKey('grid')?.kind, 'grid')
  const k = searchedKey('Brooklyn, NY', { lat: 40.6782, lng: -73.9442 })
  const p = parseCityKey(k)
  assert.ok(p && p.kind === 'search' && p.name === 'Brooklyn  NY' && p.center.lat === 40.6782)
  for (const bad of ['', 'paris', '@99,0,x', '@1,2,', '<script>']) assert.equal(parseCityKey(bad), null, bad)
})

test('every preset ships a baked file that generates a deterministic real-city day', () => {
  for (const p of PRESETS) {
    const geo = JSON.parse(readFileSync(new URL(`../../public/cities/${p.id}.json`, import.meta.url), 'utf8')) as CityGeo
    assert.equal(geo.name, p.name)
    assert.ok(geo.stores.length >= 12, p.id)
  }
  const geo = JSON.parse(readFileSync(new URL('../../public/cities/waterloo.json', import.meta.url), 'utf8')) as CityGeo
  const a = generateCity('dinner', 7, 0, geo)
  const b = generateCity('dinner', 7, 0, geo)
  assert.deepEqual(a.orders.slice(0, 20), b.orders.slice(0, 20))
  const real = new Set(geo.stores.map(([lat, lng]) => `${lat},${lng}`))
  assert.ok(a.orders.every(o => real.has(`${o.store.lat},${o.store.lng}`)), 'every kitchen is a mapped restaurant')
  const km = (x: { lat: number; lng: number }) => Math.hypot((x.lng - geo.center.lng) * 111.32 * Math.cos(geo.center.lat * Math.PI / 180), (x.lat - geo.center.lat) * 110.574)
  assert.ok(a.orders.every(o => km(o.customer) <= geo.radiusKm + 0.01), 'customers stay inside the mapped area')
  assert.match(a.name, /Waterloo/)
})

test('street routing follows the network and stays close to the road factor', async () => {
  const { buildRoadGraph, route } = await import('./roads.ts')
  const geo = JSON.parse(readFileSync(new URL('../../public/cities/toronto.json', import.meta.url), 'utf8')) as CityGeo
  const g = buildRoadGraph(geo)
  const day = generateCity('lunch', 3, 0, geo)
  const kx = 111.32 * Math.cos((geo.center.lat * Math.PI) / 180)
  const len = (pts: { lat: number; lng: number }[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot((p.lng - pts[i].lng) * kx, (p.lat - pts[i].lat) * 110.574), 0)
  let ratio = 0
  let n = 0
  for (const o of day.orders.slice(0, 150)) {
    const path = route(g, o.store, o.customer)
    assert.deepEqual(path[0], o.store)
    assert.deepEqual(path[path.length - 1], o.customer)
    const straight = len([o.store, o.customer])
    if (straight > 0.4) { ratio += len(path) / straight; n++ }
  }
  // Real detours average close to the simulator's 1.35 road factor.
  assert.ok(n > 50 && ratio / n > 1.15 && ratio / n < 1.6, `mean detour ${(ratio / n).toFixed(2)}`)
})
