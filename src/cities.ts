import { useEffect, useState } from 'react'
import { cityFromOverpass, overpassQuery, parseCityKey, type CityGeo } from './engine/city.ts'
import type { LatLng } from './engine/types.ts'

// Public OpenStreetMap services. Both send CORS headers; the Overpass mirrors are tried in order.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
const CACHE_PREFIX = 'dispatch-lab-city:'

const memory = new Map<string, Promise<CityGeo | null>>()

export interface Place { name: string; detail: string; center: LatLng }

/** Geocodes a place name. Called on submit only, per Nominatim's usage policy (no search-as-you-type). */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `${NOMINATIM}?${new URLSearchParams({ q, format: 'jsonv2', limit: '5', addressdetails: '0', 'accept-language': 'en' })}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status}).`)
  const list = (await res.json()) as { name?: string; display_name: string; lat: string; lon: string }[]
  return list.map(p => {
    const parts = p.display_name.split(', ')
    return { name: p.name || parts[0], detail: parts.slice(1, 4).join(', '), center: { lat: Number(p.lat), lng: Number(p.lon) } }
  }).filter(p => Number.isFinite(p.center.lat) && Number.isFinite(p.center.lng))
}

async function fetchLive(name: string, center: LatLng): Promise<CityGeo> {
  let last = ''
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: overpassQuery(center) }),
        signal: AbortSignal.timeout(100_000),
      })
      if (!res.ok) { last = `HTTP ${res.status}`; continue }
      return cityFromOverpass(await res.json(), name, center)
    } catch (e) {
      // A thin area is a real answer, not a server problem; do not retry it on a mirror.
      if (e instanceof Error && /restaurants are mapped|streets are mapped/.test(e.message)) throw e
      last = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(`OpenStreetMap's free map servers are busy right now (${last}). Pick one of the ready-made cities, or try again in a few minutes.`)
}

function remember(key: string, geo: CityGeo) {
  try {
    // Keep only the most recent searched city; each is a few hundred KB.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(CACHE_PREFIX) && k !== CACHE_PREFIX + key) localStorage.removeItem(k)
    }
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(geo))
  } catch { /* Storage full: the city still works for this session. */ }
}

/** Resolves a city key to geography. 'grid' (and anything unrecognised) is the fictional city: null. */
export function loadCity(key: string): Promise<CityGeo | null> {
  const hit = memory.get(key)
  if (hit) return hit
  const parsed = parseCityKey(key)
  let p: Promise<CityGeo | null>
  if (!parsed || parsed.kind === 'grid') p = Promise.resolve(null)
  else if (parsed.kind === 'preset') {
    p = fetch(`/cities/${parsed.preset.id}.json`).then(r => {
      if (!r.ok) throw new Error(`Could not load ${parsed.preset.name} (HTTP ${r.status}).`)
      return r.json() as Promise<CityGeo>
    })
  } else {
    let cached: CityGeo | null = null
    try { const raw = localStorage.getItem(CACHE_PREFIX + key); if (raw) cached = JSON.parse(raw) as CityGeo } catch { /* ignore */ }
    p = cached ? Promise.resolve(cached) : fetchLive(parsed.name, parsed.center).then(g => { remember(key, g); return g })
  }
  // Failures are not cached, so a retry goes back to the network.
  p.catch(() => memory.delete(key))
  memory.set(key, p)
  return p
}

export function useCity(key: string): { city: CityGeo | null; loading: boolean; error: string } {
  const [state, setState] = useState<{ key: string; city: CityGeo | null; error: string } | null>(null)
  useEffect(() => {
    let live = true
    loadCity(key).then(
      city => { if (live) setState({ key, city, error: '' }) },
      e => { if (live) setState({ key, city: null, error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => { live = false }
  }, [key])
  const current = state?.key === key ? state : null
  return { city: current?.city ?? null, loading: !current, error: current?.error ?? '' }
}
