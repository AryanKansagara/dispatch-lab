import type { LatLng } from './types.ts'

/**
 * A real neighbourhood from OpenStreetMap: restaurants, the street network and a few landmarks.
 * Kept compact (flat coordinate arrays, 5 decimals) so it can ship as a static file or sit in
 * localStorage. Orders, couriers and timings are still synthetic; only the geography is real.
 */
export interface CityGeo {
  name: string
  center: LatLng
  radiusKm: number
  /** [lat, lng, kind] where kind 0 is a restaurant, 1 fast food, 2 a cafe. */
  stores: [number, number, number][]
  /** Polylines as flat [lat, lng, lat, lng, ...]. Class 0 is a local street, 1 a collector, 2 an arterial. */
  streets: { c: 0 | 1 | 2; p: number[] }[]
  parks: number[][]
  water: number[][]
  fetchedAt: string
}

export interface CityPreset { id: string; name: string; lat: number; lng: number }

/** Baked into /cities at build time, so these load instantly and never depend on a live API. */
export const PRESETS: CityPreset[] = [
  { id: 'toronto', name: 'Toronto', lat: 43.6532, lng: -79.3832 },
  { id: 'new-york', name: 'New York', lat: 40.7484, lng: -73.9857 },
  { id: 'san-francisco', name: 'San Francisco', lat: 37.7793, lng: -122.4193 },
  { id: 'chicago', name: 'Chicago', lat: 41.8858, lng: -87.6316 },
  { id: 'los-angeles', name: 'Los Angeles', lat: 34.0614, lng: -118.3006 },
  { id: 'vancouver', name: 'Vancouver', lat: 49.2827, lng: -123.1207 },
  { id: 'montreal', name: 'Montreal', lat: 45.5048, lng: -73.5772 },
  { id: 'waterloo', name: 'Waterloo', lat: 43.4643, lng: -80.5204 },
  { id: 'london', name: 'London', lat: 51.5138, lng: -0.1300 },
]

export const RADIUS_KM = 3

const STREET_CLASS: Record<string, 0 | 1 | 2> = {
  residential: 0, living_street: 0, unclassified: 0,
  tertiary: 1, tertiary_link: 1, secondary: 1, secondary_link: 1,
  primary: 2, primary_link: 2, trunk: 2, trunk_link: 2,
}
const STORE_KIND: Record<string, number> = { restaurant: 0, fast_food: 1, cafe: 2 }

export function overpassQuery(c: LatLng, radiusKm = RADIUS_KM): string {
  const at = `(around:${Math.round(radiusKm * 1000)},${c.lat.toFixed(5)},${c.lng.toFixed(5)})`
  return `[out:json][timeout:90];(nwr["amenity"~"^(restaurant|fast_food|cafe)$"]${at};way["highway"~"^(${Object.keys(STREET_CLASS).join('|')})$"]${at};way["leisure"="park"]${at};way["natural"="water"]${at};);out tags center geom qt;`
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5
const KM_LAT = 110.574

function km(a: LatLng, b: LatLng) {
  const x = (b.lng - a.lng) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  const y = (b.lat - a.lat) * KM_LAT
  return Math.hypot(x, y)
}

/**
 * Drops vertices closer than `minKm` to the last kept one. End points and any vertex in `keep`
 * (street intersections) always stay, so the thinned streets still connect into a network.
 */
function thin(pts: LatLng[], minKm: number, keep?: Set<string>): number[] {
  const out: number[] = []
  let last: LatLng | null = null
  pts.forEach((p, i) => {
    if (last && i < pts.length - 1 && km(last, p) < minKm && !keep?.has(`${r5(p.lat)},${r5(p.lng)}`)) return
    out.push(r5(p.lat), r5(p.lng))
    last = p
  })
  return out
}

interface OsmElement {
  type: string
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  geometry?: ({ lat: number; lon: number } | null)[]
  tags?: Record<string, string>
}

/** Turns an Overpass response into a compact CityGeo. Throws when the area is too thin to simulate. */
export function cityFromOverpass(json: unknown, name: string, center: LatLng, radiusKm = RADIUS_KM, fetchedAt = new Date().toISOString().slice(0, 10)): CityGeo {
  const elements = (json as { elements?: OsmElement[] })?.elements
  if (!Array.isArray(elements)) throw new Error('OpenStreetMap returned an unexpected response.')
  const stores: CityGeo['stores'] = []
  const streets: CityGeo['streets'] = []
  const parks: number[][] = []
  const water: number[][] = []
  const seen = new Set<string>()
  // Vertices shared by two or more streets are intersections; thinning must not drop them.
  const uses = new Map<string, number>()
  for (const el of elements) {
    if (STREET_CLASS[el.tags?.highway ?? ''] === undefined) continue
    for (const g of el.geometry ?? []) if (g) { const k = `${r5(g.lat)},${r5(g.lon)}`; uses.set(k, (uses.get(k) ?? 0) + 1) }
  }
  const junctions = new Set([...uses].filter(([, n]) => n > 1).map(([k]) => k))
  for (const el of elements) {
    const tags = el.tags ?? {}
    const kind = STORE_KIND[tags.amenity ?? '']
    if (kind !== undefined) {
      const lat = el.lat ?? el.center?.lat
      const lng = el.lon ?? el.center?.lon
      if (lat === undefined || lng === undefined || km(center, { lat, lng }) > radiusKm) continue
      const key = `${r5(lat)},${r5(lng)}`
      if (seen.has(key)) continue
      seen.add(key)
      stores.push([r5(lat), r5(lng), kind])
      continue
    }
    const pts = (el.geometry ?? []).filter((g): g is { lat: number; lon: number } => !!g).map(g => ({ lat: g.lat, lng: g.lon }))
    if (pts.length < 2) continue
    const cls = STREET_CLASS[tags.highway ?? '']
    if (cls !== undefined) streets.push({ c: cls, p: thin(pts, 0.012, junctions) })
    else if (tags.leisure === 'park' && pts.length > 3) parks.push(thin(pts, 0.02))
    else if (tags.natural === 'water' && pts.length > 3) water.push(thin(pts, 0.02))
  }
  const connected = mainNetwork(streets, stores)
  streets.splice(0, streets.length, ...connected.streets)
  stores.splice(0, stores.length, ...connected.stores)
  if (stores.length < 12) throw new Error(`Only ${stores.length} restaurants are mapped within ${radiusKm} km of ${name}. Try a denser area or a nearby city centre.`)
  if (streets.filter(s => s.c === 0 || s.c === 1).length < 20) throw new Error(`Too few streets are mapped around ${name} to place customers.`)
  return { name, center: { lat: r5(center.lat), lng: r5(center.lng) }, radiusKm, stores, streets, parks, water, fetchedAt }
}

/**
 * Keeps the largest connected street network and the restaurants on it. Islands, the far side of a
 * river with no mapped bridge, and private loops would otherwise get orders no courier can reach.
 */
function mainNetwork(streets: CityGeo['streets'], stores: CityGeo['stores']) {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = k
    while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n }
    return r
  }
  const keyAt = (p: number[], i: number) => `${p[i]},${p[i + 1]}`
  for (const s of streets) {
    for (let i = 0; i < s.p.length; i += 2) { const k = keyAt(s.p, i); if (!parent.has(k)) parent.set(k, k) }
    for (let i = 2; i < s.p.length; i += 2) { const a = find(keyAt(s.p, i - 2)); const b = find(keyAt(s.p, i)); if (a !== b) parent.set(a, b) }
  }
  const size = new Map<string, number>()
  for (const k of parent.keys()) { const r = find(k); size.set(r, (size.get(r) ?? 0) + 1) }
  let main = ''
  let best = -1
  for (const [r, n] of size) if (n > best) { best = n; main = r }
  const kept = streets.filter(s => find(keyAt(s.p, 0)) === main)
  // A restaurant counts as on the network when a kept street vertex is within about 150 m.
  const cell = 0.0015
  const grid = new Set<string>()
  for (const s of kept) for (let i = 0; i < s.p.length; i += 2) grid.add(`${Math.floor(s.p[i] / cell)},${Math.floor(s.p[i + 1] / cell)}`)
  const near = ([lat, lng]: [number, number, number]) => {
    const x = Math.floor(lat / cell)
    const y = Math.floor(lng / cell)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (grid.has(`${x + dx},${y + dy}`)) return true
    return false
  }
  return { streets: kept, stores: stores.filter(near) }
}

/**
 * Evenly spaced points along local and collector streets: where customers live. Deterministic, so a
 * seed always produces the same city.
 */
export function addressPoints(geo: CityGeo, spacingKm = 0.06): LatLng[] {
  const out: LatLng[] = []
  for (const s of geo.streets) {
    if (s.c === 2) continue
    let carry = 0
    for (let i = 2; i < s.p.length; i += 2) {
      const a = { lat: s.p[i - 2], lng: s.p[i - 1] }
      const b = { lat: s.p[i], lng: s.p[i + 1] }
      const len = km(a, b)
      let d = spacingKm - carry
      while (d <= len) {
        const f = d / len
        const p = { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }
        if (km(geo.center, p) <= geo.radiusKm) out.push(p)
        d += spacingKm
      }
      carry = len - (d - spacingKm)
    }
  }
  return out
}

/** Settings key for a city: 'grid', a preset id, or a searched place as "@lat,lng,name". */
export type CityKey = string

export function searchedKey(name: string, c: LatLng): CityKey {
  return `@${c.lat.toFixed(4)},${c.lng.toFixed(4)},${name.replace(/[,#&=]/g, ' ').slice(0, 60).trim()}`
}

export function parseCityKey(key: string | null | undefined): { kind: 'grid' } | { kind: 'preset'; preset: CityPreset } | { kind: 'search'; name: string; center: LatLng } | null {
  if (!key) return null
  if (key === 'grid') return { kind: 'grid' }
  const preset = PRESETS.find(p => p.id === key)
  if (preset) return { kind: 'preset', preset }
  const m = /^@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?),(.{1,60})$/.exec(key)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return null
  return { kind: 'search', name: m[3], center: { lat, lng } }
}

export const cityLabel = (key: string) => {
  const p = parseCityKey(key)
  return !p || p.kind === 'grid' ? 'Fictional grid city' : p.kind === 'preset' ? p.preset.name : p.name
}
