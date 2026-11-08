import type { CityGeo } from './city.ts'
import type { LatLng } from './types.ts'

/**
 * The street network as a graph, for drawing couriers along real streets. Drive times in the
 * simulator still come from straight-line distance times the road factor; this is the picture.
 */
export interface RoadGraph {
  lat: Float64Array
  lng: Float64Array
  /** CSR adjacency: neighbours of node i are adj[start[i] .. start[i + 1]). */
  start: Int32Array
  adj: Int32Array
  w: Float32Array
  kx: number
  bucket: Map<string, number[]>
}

const KM_LAT = 110.574
const CELL_KM = 0.15

export function buildRoadGraph(city: CityGeo): RoadGraph {
  const kx = 111.32 * Math.cos((city.center.lat * Math.PI) / 180)
  const ids = new Map<string, number>()
  const lat: number[] = []
  const lng: number[] = []
  const edges: [number, number][] = []
  const node = (a: number, b: number) => {
    const k = `${a},${b}`
    let i = ids.get(k)
    if (i === undefined) { i = lat.length; ids.set(k, i); lat.push(a); lng.push(b) }
    return i
  }
  for (const s of city.streets) {
    let prev = -1
    for (let i = 0; i < s.p.length; i += 2) {
      const n = node(s.p[i], s.p[i + 1])
      if (prev >= 0 && prev !== n) edges.push([prev, n])
      prev = n
    }
  }
  const deg = new Int32Array(lat.length + 1)
  for (const [a, b] of edges) { deg[a + 1]++; deg[b + 1]++ }
  for (let i = 1; i < deg.length; i++) deg[i] += deg[i - 1]
  const fill = deg.slice(0, lat.length)
  const adj = new Int32Array(edges.length * 2)
  const w = new Float32Array(edges.length * 2)
  for (const [a, b] of edges) {
    const d = Math.hypot((lng[b] - lng[a]) * kx, (lat[b] - lat[a]) * KM_LAT)
    adj[fill[a]] = b; w[fill[a]++] = d
    adj[fill[b]] = a; w[fill[b]++] = d
  }
  const bucket = new Map<string, number[]>()
  for (let i = 0; i < lat.length; i++) {
    const k = `${Math.floor((lng[i] * kx) / CELL_KM)},${Math.floor((lat[i] * KM_LAT) / CELL_KM)}`
    const list = bucket.get(k)
    if (list) list.push(i)
    else bucket.set(k, [i])
  }
  return { lat: Float64Array.from(lat), lng: Float64Array.from(lng), start: deg, adj, w, kx, bucket }
}

function nearest(g: RoadGraph, p: LatLng): number {
  const cx = Math.floor((p.lng * g.kx) / CELL_KM)
  const cy = Math.floor((p.lat * KM_LAT) / CELL_KM)
  let best = -1
  let bestD = Infinity
  for (let ring = 0; ring <= 3 && best < 0; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        for (const i of g.bucket.get(`${cx + dx},${cy + dy}`) ?? []) {
          const d = ((g.lng[i] - p.lng) * g.kx) ** 2 + ((g.lat[i] - p.lat) * KM_LAT) ** 2
          if (d < bestD) { bestD = d; best = i }
        }
      }
    }
  }
  return best
}

/**
 * A* over the street graph. Returns the polyline from a to b along streets, or a straight line
 * when either end is far from any street or the streets do not connect.
 */
export function route(g: RoadGraph, a: LatLng, b: LatLng, maxVisits = 40000): LatLng[] {
  const s = nearest(g, a)
  const t = nearest(g, b)
  if (s < 0 || t < 0) return [a, b]
  if (s === t) return [a, { lat: g.lat[s], lng: g.lng[s] }, b]
  const n = g.lat.length
  const dist = new Float64Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  const h = (i: number) => Math.hypot((g.lng[i] - g.lng[t]) * g.kx, (g.lat[i] - g.lat[t]) * KM_LAT)
  // Binary heap of [f, node] pairs.
  const heapF: number[] = []
  const heapN: number[] = []
  const push = (f: number, i: number) => {
    let k = heapF.length
    heapF.push(f); heapN.push(i)
    while (k > 0) {
      const up = (k - 1) >> 1
      if (heapF[up] <= f) break
      heapF[k] = heapF[up]; heapN[k] = heapN[up]; k = up
    }
    heapF[k] = f; heapN[k] = i
  }
  const pop = () => {
    const top = heapN[0]
    const lastF = heapF.pop()!
    const lastN = heapN.pop()!
    if (heapF.length) {
      let k = 0
      for (;;) {
        let c = 2 * k + 1
        if (c >= heapF.length) break
        if (c + 1 < heapF.length && heapF[c + 1] < heapF[c]) c++
        if (heapF[c] >= lastF) break
        heapF[k] = heapF[c]; heapN[k] = heapN[c]; k = c
      }
      heapF[k] = lastF; heapN[k] = lastN
    }
    return top
  }
  dist[s] = 0
  push(h(s), s)
  let visits = 0
  while (heapF.length && visits++ < maxVisits) {
    const u = pop()
    if (u === t) break
    for (let e = g.start[u]; e < g.start[u + 1]; e++) {
      const v = g.adj[e]
      const d = dist[u] + g.w[e]
      if (d < dist[v]) { dist[v] = d; from[v] = u; push(d + h(v), v) }
    }
  }
  if (from[t] < 0) return [a, b]
  const path: LatLng[] = [b]
  for (let i = t; i >= 0; i = from[i]) path.push({ lat: g.lat[i], lng: g.lng[i] })
  path.push(a)
  return path.reverse()
}
