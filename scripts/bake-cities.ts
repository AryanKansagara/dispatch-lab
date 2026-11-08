// Builds public/cities/<id>.json for each preset, so the default cities load instantly and never
// depend on a live API. Input is OpenStreetMap data in the Overpass JSON shape, either fetched live
// or converted from a city extract (e.g. BBBike .osm.pbf) into <dir>/<id>.osm.json.
// Run: node scripts/bake-cities.ts [--from <dir>] [id ...]
import { readFileSync, writeFileSync } from 'node:fs'
import { cityFromOverpass, overpassQuery, PRESETS, RADIUS_KM, type CityPreset } from '../src/engine/city.ts'

const args = process.argv.slice(2)
const fromAt = args.indexOf('--from')
const fromDir = fromAt >= 0 ? args.splice(fromAt, 2)[1] : ''
const only = args

async function osmJson(p: CityPreset): Promise<unknown> {
  if (fromDir) return JSON.parse(readFileSync(`${fromDir}/${p.id}.osm.json`, 'utf8'))
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: overpassQuery(p) }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

for (const p of PRESETS.filter(p => !only.length || only.includes(p.id))) {
  try {
    const geo = cityFromOverpass(await osmJson(p), p.name, p, RADIUS_KM, new Date().toISOString().slice(0, 10))
    const out = JSON.stringify(geo)
    writeFileSync(new URL(`../public/cities/${p.id}.json`, import.meta.url), out)
    console.log(`${p.id}: ${geo.stores.length} stores, ${geo.streets.length} streets, ${geo.parks.length} parks, ${(out.length / 1024).toFixed(0)} KB`)
  } catch (e) {
    console.log(`${p.id}: failed: ${(e as Error).message}`)
    process.exitCode = 1
  }
}
