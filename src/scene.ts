import type { CityGeo } from './engine/city.ts'
import { tempAt } from './engine/metrics.ts'
import { buildRoadGraph, route, type RoadGraph } from './engine/roads.ts'
import type { CourierState, LatLng, OrderState, SimResult } from './engine/types.ts'

export interface MapPalette {
  ground: string; roof: string; sideA: string; sideB: string; road: string; arterial: string; water: string; park: string
  ink: string; muted: string; idle: string; ring: string; route: string; stack: string; store: string
}

const LIGHT: MapPalette = {
  ground: '#efefed', roof: '#ffffff', sideA: '#e6e6e6', sideB: '#dcdcdc', road: '#f4f4f2', arterial: '#fbfbfb',
  water: '#cfe4f3', park: '#d9eed2', ink: '#191919', muted: '#606060', idle: '#8a8a8a', ring: '#ffffff',
  route: 'rgba(25,25,25,.28)', stack: '#eb1700', store: '#191919',
}
const DARK: MapPalette = {
  ground: '#141414', roof: '#242424', sideA: '#1c1c1c', sideB: '#191919', road: '#161616', arterial: '#303030',
  water: '#10263a', park: '#14281b', ink: '#f7f7f7', muted: '#a8a8a8', idle: '#7a7a7a', ring: '#111111',
  route: 'rgba(247,247,247,.3)', stack: '#ff4a33', store: '#f7f7f7',
}
export const paletteFor = (dark: boolean) => (dark ? DARK : LIGHT)

// Semantic heat ramp: hot brand red through amber to a cold blue, indexed by whole degrees C.
const HEAT: [number, [number, number, number]][] = [
  [74, [235, 23, 0]], [64, [255, 106, 26]], [56, [240, 170, 30]], [50, [150, 165, 175]], [42, [60, 130, 215]], [22, [30, 90, 190]],
]
const lut = new Map<number, string>()
export function tempColor(c: number): string {
  const k = Math.round(c)
  const hit = lut.get(k)
  if (hit) return hit
  let out = `rgb(${HEAT[HEAT.length - 1][1].join(',')})`
  for (let i = 0; i < HEAT.length - 1; i++) {
    const [hi, a] = HEAT[i]
    const [lo, b] = HEAT[i + 1]
    if (k >= lo) {
      const f = Math.min(1, (hi - k) / (hi - lo))
      out = `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`
      break
    }
  }
  lut.set(k, out)
  return out
}
/** Prep "heats up" from a pale orange to the hot red it leaves the kitchen at. */
function prepColor(f: number): string {
  const a = [255, 209, 170]
  const b = [235, 23, 0]
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`
}

const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

interface P { x: number; y: number }
/** A street path in world coordinates with cumulative length, for interpolating along it. */
interface Poly { pts: P[]; cum: number[] }

const graphs = new WeakMap<CityGeo, RoadGraph>()
function graphFor(city: CityGeo) {
  let g = graphs.get(city)
  if (!g) { g = buildRoadGraph(city); graphs.set(city, g) }
  return g
}
/** The fictional grid is drawn as a rotated isometric block city; real maps stay north-up. */
const GRID_VIEW = { cos: Math.cos(-0.46), sin: Math.sin(-0.46), squish: 0.66 }
const REAL_VIEW = { cos: 1, sin: 0, squish: 0.82 }

export interface DrawOptions { selected: number; dim: boolean; dark: boolean }
export interface LiveStats { waiting: number; carried: number; delivered: number; onRoad: number; idle: number; stacksLive: number }

export class Scene {
  r: SimResult
  private lat0: number
  private lng0: number
  private kmLng: number
  private halfW: number
  private halfH: number
  private cell: number
  private byCourier: OrderState[][]
  private store: P[]
  private cust: P[]
  private lastLeg: Int32Array
  private scale = 1
  private ox = 0
  private oy = 0
  private cssW = 0
  private cssH = 0
  private staticLayer: HTMLCanvasElement | null = null
  private staticKey = ''
  private dpr = 1

  private city: CityGeo | null
  private graph: RoadGraph | null = null
  private paths = new Map<string, Poly>()
  private COS: number
  private SIN: number
  private SQUISH: number

  constructor(r: SimResult, city?: CityGeo | null) {
    this.r = r
    this.city = city ?? null
    const view = this.city ? REAL_VIEW : GRID_VIEW
    this.COS = view.cos
    this.SIN = view.sin
    this.SQUISH = view.squish
    if (this.city) this.graph = graphFor(this.city)
    const lats = r.orders.flatMap(o => [o.src.store.lat, o.src.customer.lat])
    const lngs = r.orders.flatMap(o => [o.src.store.lng, o.src.customer.lng])
    const span = (v: number[]) => {
      const s = v.length ? [...v].sort((a, b) => a - b) : [0]
      // Trimmed bounds, so one outlier order does not shrink the whole map.
      return [s[Math.floor(s.length * 0.01)], s[Math.ceil(s.length * 0.99) - 1]]
    }
    const [latA, latB] = span(lats)
    const [lngA, lngB] = span(lngs)
    this.lat0 = (latA + latB) / 2
    this.lng0 = (lngA + lngB) / 2
    this.kmLng = 111.32 * Math.cos((this.lat0 * Math.PI) / 180)
    this.halfW = Math.max(1, ((lngB - lngA) / 2) * this.kmLng)
    this.halfH = Math.max(1, ((latB - latA) / 2) * 110.574)
    this.cell = Math.max(this.halfW, this.halfH) / 10
    this.byCourier = r.couriers.map(() => [])
    for (const o of r.orders) if (o.courier >= 0) this.byCourier[o.courier].push(o)
    this.store = r.orders.map(o => this.snap(this.world(o.src.store)))
    this.cust = r.orders.map(o => this.snap(this.world(o.src.customer)))
    this.lastLeg = new Int32Array(r.couriers.length)
  }

  private world(p: LatLng): P {
    return { x: (p.lng - this.lng0) * this.kmLng, y: (p.lat - this.lat0) * 110.574 }
  }
  /** Stops sit on street intersections so couriers visibly drive the grid. Real maps keep true positions. */
  private snap(p: P): P {
    if (this.city) return p
    return { x: Math.round(p.x / this.cell) * this.cell, y: Math.round(p.y / this.cell) * this.cell }
  }
  private sx(x: number, y: number) { return this.ox + this.scale * (x * this.COS - y * this.SIN) }
  private sy(x: number, y: number) { return this.oy - this.scale * this.SQUISH * (x * this.SIN + y * this.COS) }

  /** focusX places the city centre, cover overfills the canvas (the landing hero). */
  layout(w: number, h: number, dpr: number, cover: boolean, focusX = 0.5) {
    this.cssW = w
    this.cssH = h
    this.dpr = dpr
    // Fit to where the action is, trimmed, rather than the rotated bounding box of the map.
    const us = [...this.store, ...this.cust].map(p => p.x * this.COS - p.y * this.SIN).sort((a, b) => a - b)
    const vs = [...this.store, ...this.cust].map(p => this.SQUISH * (p.x * this.SIN + p.y * this.COS)).sort((a, b) => a - b)
    const at = (v: number[], q: number) => v[Math.min(v.length - 1, Math.floor(v.length * q))] ?? 0
    const pw = Math.max(1, at(us, 0.985) - at(us, 0.015))
    const ph = Math.max(1, at(vs, 0.985) - at(vs, 0.015))
    this.scale = cover ? Math.max((w * 0.6) / pw, (h * 0.8) / ph) : Math.min((w * 0.92) / pw, (h * 0.78) / ph)
    // Centre on the trimmed middle of the action, not on the raw coordinate origin.
    this.ox = w * focusX - this.scale * (at(us, 0.985) + at(us, 0.015)) / 2
    this.oy = h * 0.5 + this.scale * (at(vs, 0.985) + at(vs, 0.015)) / 2
  }

  private paintStatic(dark: boolean) {
    const key = `${this.cssW}x${this.cssH}@${this.dpr}/${dark}/${this.scale}/${this.ox}`
    if (this.staticLayer && this.staticKey === key) return this.staticLayer
    const pal = paletteFor(dark)
    const c = this.staticLayer ?? document.createElement('canvas')
    c.width = Math.max(1, Math.round(this.cssW * this.dpr))
    c.height = Math.max(1, Math.round(this.cssH * this.dpr))
    const g = c.getContext('2d')!
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = pal.ground
    g.fillRect(0, 0, this.cssW, this.cssH)
    if (this.city) {
      this.paintCity(g, pal)
      this.staticLayer = c
      this.staticKey = key
      return c
    }

    const stores: P[] = []
    const seen = new Set<string>()
    for (const p of this.store) {
      const k = `${p.x},${p.y}`
      if (!seen.has(k)) { seen.add(k); stores.push(p) }
    }
    const sample = stores.slice(0, 200)
    const cell = this.cell
    const reach = Math.ceil(Math.max(this.cssW, this.cssH) / this.scale / cell) + 4
    const riverAt = (x: number) => this.halfH * 0.42 * Math.sin(x / (this.halfW * 0.55) + 0.8) - this.halfH * 0.32

    const line = (x0: number, y0: number, x1: number, y1: number) => {
      g.beginPath()
      g.moveTo(this.sx(x0, y0), this.sy(x0, y0))
      g.lineTo(this.sx(x1, y1), this.sy(x1, y1))
      g.stroke()
    }
    const lim = reach * cell
    g.strokeStyle = pal.road
    g.lineWidth = Math.max(1, cell * this.scale * 0.14)
    for (let i = -reach; i <= reach; i++) { line(i * cell, -lim, i * cell, lim); line(-lim, i * cell, lim, i * cell) }
    g.strokeStyle = pal.arterial
    g.lineWidth = Math.max(2, cell * this.scale * 0.3)
    for (let i = -reach; i <= reach; i++) {
      if (((i % 5) + 5) % 5 === 0) { line(i * cell, -lim, i * cell, lim); line(-lim, i * cell, lim, i * cell) }
    }

    // River: a band following a sine, painted under the blocks and left clear of them.
    g.strokeStyle = pal.water
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.lineWidth = cell * this.scale * 1.5
    g.beginPath()
    for (let x = -lim; x <= lim; x += cell / 2) {
      const y = riverAt(x)
      if (x === -lim) g.moveTo(this.sx(x, y), this.sy(x, y))
      else g.lineTo(this.sx(x, y), this.sy(x, y))
    }
    g.stroke()

    const blocks: { ix: number; iy: number; depth: number }[] = []
    for (let ix = -reach; ix < reach; ix++) {
      for (let iy = -reach; iy < reach; iy++) {
        const cx = (ix + 0.5) * cell
        const cy = (iy + 0.5) * cell
        const px = this.sx(cx, cy)
        const py = this.sy(cx, cy)
        if (px < -60 || px > this.cssW + 60 || py < -40 || py > this.cssH + 80) continue
        if (Math.abs(cy - riverAt(cx)) < cell * 1.05) continue
        blocks.push({ ix, iy, depth: py })
      }
    }
    blocks.sort((a, b) => a.depth - b.depth)
    const unit = cell * this.scale
    for (const { ix, iy } of blocks) {
      const inset = (i: number) => (((i % 5) + 5) % 5 === 0 ? 0.16 : 0.08) * cell
      const x0 = ix * cell + inset(ix)
      const x1 = (ix + 1) * cell - inset(ix + 1)
      const y0 = iy * cell + inset(iy)
      const y1 = (iy + 1) * cell - inset(iy + 1)
      const noise = hash(ix, iy)
      const corners: P[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
      const pts = corners.map(p => ({ x: this.sx(p.x, p.y), y: this.sy(p.x, p.y) }))
      const poly = (ps: P[], fill: string) => {
        g.fillStyle = fill
        g.beginPath()
        ps.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
        g.closePath()
        g.fill()
      }
      if (noise < 0.07) { poly(pts, pal.park); continue }
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      let density = 0
      for (const s of sample) density += Math.exp(-((s.x - cx) ** 2 + (s.y - cy) ** 2) / (2 * (cell * 2.4) ** 2))
      const height = unit * (0.1 + Math.min(1, density / 6) * 0.75 + hash(iy, ix) * 0.16)
      const roof = pts.map(p => ({ x: p.x, y: p.y - height }))
      for (let i = 0; i < 4; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % 4]
        // In screen space the polygon winds one way; only edges facing the viewer get a wall.
        const cross = (b.x - a.x) * (pts[(i + 2) % 4].y - a.y) - (b.y - a.y) * (pts[(i + 2) % 4].x - a.x)
        const outwardDown = cross > 0 ? (b.x - a.x) < 0 : (b.x - a.x) > 0
        if (!outwardDown) continue
        poly([a, b, roof[(i + 1) % 4], roof[i]], i % 2 ? pal.sideA : pal.sideB)
      }
      poly(roof, pal.roof)
    }
    this.staticLayer = c
    this.staticKey = key
    return c
  }

  /** Real streets, parks and water from OpenStreetMap, with every mapped restaurant as a faint dot. */
  private paintCity(g: CanvasRenderingContext2D, pal: MapPalette) {
    const city = this.city!
    const trace = (flat: number[], close: boolean) => {
      g.beginPath()
      for (let i = 0; i < flat.length; i += 2) {
        const w = this.world({ lat: flat[i], lng: flat[i + 1] })
        const x = this.sx(w.x, w.y)
        const y = this.sy(w.x, w.y)
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      }
      if (close) g.closePath()
    }
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.fillStyle = pal.park
    for (const poly of city.parks) { trace(poly, true); g.fill() }
    g.fillStyle = pal.water
    for (const poly of city.water) { trace(poly, true); g.fill() }
    const zoom = Math.max(0.6, Math.min(2.2, this.scale / 60))
    const widths = [1.1, 2.2, 3.6]
    // A darker casing under each street, then the fill, so roads read on either theme.
    for (const pass of ['casing', 'fill'] as const) {
      for (const cls of [0, 1, 2] as const) {
        g.strokeStyle = pass === 'casing' ? pal.sideB : pal.roof
        g.lineWidth = widths[cls] * zoom + (pass === 'casing' ? 1.4 : 0)
        for (const st of city.streets) if (st.c === cls) { trace(st.p, false); g.stroke() }
      }
    }
    // Every mapped restaurant as a faint dot; the busy kitchens light up on top during the run.
    g.fillStyle = pal.muted
    g.globalAlpha = 0.28
    for (const [lat, lng] of city.stores) {
      const w = this.world({ lat, lng })
      g.beginPath()
      g.arc(this.sx(w.x, w.y), this.sy(w.x, w.y), 1.1 * zoom, 0, 6.3)
      g.fill()
    }
    g.globalAlpha = 1
  }

  /** The street route between two places, cached: each leg is routed once, the first time it is drawn. */
  private polyFor(a: LatLng, b: LatLng): Poly {
    const key = `${a.lat},${a.lng}>${b.lat},${b.lng}`
    let poly = this.paths.get(key)
    if (!poly) {
      const pts = (this.graph ? route(this.graph, a, b) : [a, b]).map(p => this.world(p))
      const cum = [0]
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
      poly = { pts, cum }
      this.paths.set(key, poly)
    }
    return poly
  }

  private polyPoint(poly: Poly, f: number): P {
    const total = poly.cum[poly.cum.length - 1]
    const d = Math.max(0, Math.min(1, f)) * total
    let i = 1
    while (i < poly.cum.length - 1 && poly.cum[i] < d) i++
    const span = poly.cum[i] - poly.cum[i - 1] || 1
    const k = (d - poly.cum[i - 1]) / span
    const a = poly.pts[i - 1]
    const b = poly.pts[i]
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
  }

  /** Traces a street route from fraction f to its end onto the current canvas path. */
  private tracePoly(ctx: CanvasRenderingContext2D, poly: Poly, f: number, P2: (p: P) => P) {
    const d = Math.max(0, Math.min(1, f)) * poly.cum[poly.cum.length - 1]
    for (let i = 1; i < poly.pts.length; i++) {
      if (poly.cum[i] <= d) continue
      const q = P2(poly.pts[i])
      ctx.lineTo(q.x, q.y)
    }
  }

  private pathPoint(a: P, b: P, f: number): P {
    // Real maps have no routing graph here, so couriers move point to point (drive time still uses the road factor).
    if (this.city) return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
    const dx = Math.abs(b.x - a.x)
    const dy = Math.abs(b.y - a.y)
    const along = (dx + dy) * f
    if (along <= dx) return { x: a.x + Math.sign(b.x - a.x) * along, y: a.y }
    return { x: b.x, y: a.y + Math.sign(b.y - a.y) * (along - dx) }
  }

  /** Courier position at time t, on the street grid. Keeps a per-courier cursor for fast playback. */
  private courierAt(c: CourierState, t: number): { p: P; here: LatLng; driving: boolean; a?: P; b?: P; f?: number; poly?: Poly; to?: LatLng } {
    const legs = c.legs
    if (!legs.length) return { p: this.snap(this.world(c.src.start)), here: c.src.start, driving: false }
    let i = this.lastLeg[c.index]
    if (i >= legs.length || legs[i].t0 > t) i = 0
    while (i < legs.length - 1 && legs[i + 1].t0 <= t) i++
    this.lastLeg[c.index] = i
    const leg = legs[i]
    if (t < leg.t0) return { p: this.snap(this.world(leg.from)), here: leg.from, driving: false }
    if (t >= leg.t1 || leg.kind !== 'drive') return { p: this.snap(this.world(leg.to)), here: leg.to, driving: false }
    const a = this.snap(this.world(leg.from))
    const b = this.snap(this.world(leg.to))
    const f = (t - leg.t0) / Math.max(1e-6, leg.t1 - leg.t0)
    if (this.city) {
      const poly = this.polyFor(leg.from, leg.to)
      return { p: this.polyPoint(poly, f), here: leg.from, driving: true, a, b, f, poly, to: leg.to }
    }
    return { p: this.pathPoint(a, b, f), here: leg.from, driving: true, a, b, f }
  }

  private isOnline(c: CourierState, t: number) {
    const lastLeg = c.legs.length ? c.legs[c.legs.length - 1].t1 : 0
    return t >= c.src.shiftStart && t <= Math.max(c.src.shiftEnd, lastLeg)
  }

  private activeOrders(c: number, t: number) {
    return this.byCourier[c].filter(o => o.assignedAt <= t && (o.deliveredAt < 0 || t < o.deliveredAt))
  }

  /** Remaining visits in the order they really happened. */
  private remainingStops(c: number, t: number) {
    const stops: { p: P; ll: LatLng; at: number; kind: 'pickup' | 'dropoff'; o: OrderState }[] = []
    for (const o of this.activeOrders(c, t)) {
      if (o.pickedAt < 0 || t < o.pickedAt) stops.push({ p: this.store[o.index], ll: o.src.store, at: o.pickedAt < 0 ? Infinity : o.pickedAt, kind: 'pickup', o })
      stops.push({ p: this.cust[o.index], ll: o.src.customer, at: o.deliveredAt < 0 ? Infinity : o.deliveredAt, kind: 'dropoff', o })
    }
    return stops.sort((a, b) => a.at - b.at)
  }

  draw(ctx: CanvasRenderingContext2D, t: number, opt: DrawOptions) {
    const pal = paletteFor(opt.dark)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.drawImage(this.paintStatic(opt.dark), 0, 0)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const P2 = (p: P) => ({ x: this.sx(p.x, p.y), y: this.sy(p.x, p.y) })
    const u = Math.max(0.75, Math.min(1.4, this.cssW / 900))

    // Routes first, under everything. Stacks read as glowing linked routes.
    const positions = new Map<number, P>()
    for (const c of this.r.couriers) {
      if (!this.isOnline(c, t)) continue
      const at = this.courierAt(c, t)
      positions.set(c.index, at.p)
      const stops = this.remainingStops(c.index, t)
      if (!stops.length) continue
      const active = this.activeOrders(c.index, t)
      const stacked = active.length > 1 && active.some((o, i) => active.some((q, j) => i !== j && o.stackId === q.stackId && o.stackId >= 0))
      const isSel = opt.selected === c.index
      if (opt.selected >= 0 && !isSel && !stacked) continue
      ctx.beginPath()
      let prev = at.p
      if (this.city) {
        // Real maps: every remaining leg follows the street network.
        const s0 = P2(at.p)
        ctx.moveTo(s0.x, s0.y)
        let from = at.here
        let skip = false
        if (at.driving && at.poly && at.to) { this.tracePoly(ctx, at.poly, at.f ?? 0, P2); from = at.to; skip = true }
        for (const st of stops) {
          if (skip && st.ll.lat === from.lat && st.ll.lng === from.lng) { skip = false; continue }
          skip = false
          this.tracePoly(ctx, this.polyFor(from, st.ll), 0, P2)
          from = st.ll
        }
      } else if (at.driving && at.b) {
        // Finish the current street leg before heading on.
        const b = at.b
        const start = P2(at.p)
        ctx.moveTo(start.x, start.y)
        if (!this.city && at.p.x !== b.x && at.p.y !== b.y) { const m = P2({ x: b.x, y: at.p.y }); ctx.lineTo(m.x, m.y) }
        const e = P2(b)
        ctx.lineTo(e.x, e.y)
        prev = b
      } else {
        const s = P2(prev)
        ctx.moveTo(s.x, s.y)
      }
      if (!this.city) for (const s of stops) {
        if (at.driving && at.b && s.p.x === at.b.x && s.p.y === at.b.y && prev === at.b) continue
        const e = P2(s.p)
        if (!this.city) { const m = P2({ x: s.p.x, y: prev.y }); ctx.lineTo(m.x, m.y) }
        ctx.lineTo(e.x, e.y)
        prev = s.p
      }
      ctx.globalAlpha = opt.selected >= 0 && !isSel ? 0.15 : 1
      if (stacked || isSel) {
        ctx.strokeStyle = pal.stack
        ctx.lineWidth = (isSel ? 7 : 5) * u
        ctx.globalAlpha *= 0.2
        ctx.stroke()
        ctx.globalAlpha = opt.selected >= 0 && !isSel ? 0.15 : 1
        ctx.lineWidth = (isSel ? 2.6 : 1.8) * u
        ctx.stroke()
      } else {
        ctx.strokeStyle = pal.route
        ctx.lineWidth = 1 * u
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    // Orders: waiting at the store, drop-off targets, and a pop as each one lands.
    const dim = opt.selected >= 0 ? 0.28 : 1
    const carried = new Map<number, string[]>()
    for (const o of this.r.orders) {
      if (o.createdAt > t) continue
      const deliveredAt = o.deliveredAt < 0 ? Infinity : o.deliveredAt
      if (t >= deliveredAt) {
        const age = t - deliveredAt
        if (age < 3) {
          const p = P2(this.cust[o.index])
          ctx.globalAlpha = (1 - age / 3) * dim
          ctx.strokeStyle = tempColor(tempAt(o, deliveredAt))
          ctx.lineWidth = 2 * u
          ctx.beginPath()
          ctx.arc(p.x, p.y, (3 + age * 5) * u, 0, 6.3)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
        continue
      }
      const picked = o.pickedAt >= 0 && t >= o.pickedAt
      const color = t < o.readyAt ? prepColor((t - o.createdAt) / Math.max(1, o.readyAt - o.createdAt)) : tempColor(tempAt(o, t))
      ctx.globalAlpha = opt.selected >= 0 && o.courier !== opt.selected ? dim : 1
      if (picked) {
        const list = carried.get(o.courier)
        if (list) list.push(color)
        else carried.set(o.courier, [color])
        const p = P2(this.cust[o.index])
        ctx.strokeStyle = color
        ctx.lineWidth = 1.8 * u
        ctx.beginPath()
        ctx.arc(p.x, p.y, 3.4 * u, 0, 6.3)
        ctx.stroke()
      } else {
        // Fan out so a busy kitchen reads as a cluster rather than one dot.
        const base = P2(this.store[o.index])
        const a = o.index * 2.399963
        const rad = 3 * u * Math.sqrt((o.index % 7) + 0.3)
        const x = base.x + Math.cos(a) * rad
        const y = base.y + Math.sin(a) * rad * 0.7
        const ready = t >= o.readyAt
        if (ready) {
          const beat = 0.5 + 0.5 * Math.sin(t * 5 + o.index)
          ctx.strokeStyle = color
          ctx.lineWidth = 1
          ctx.globalAlpha *= 0.5
          ctx.beginPath()
          ctx.arc(x, y, (5 + beat * 2.5) * u, 0, 6.3)
          ctx.stroke()
          ctx.globalAlpha = opt.selected >= 0 && o.courier !== opt.selected ? dim : 1
        }
        ctx.fillStyle = pal.ring
        ctx.beginPath()
        ctx.arc(x, y, 3.9 * u, 0, 6.3)
        ctx.fill()
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, y, 3 * u, 0, 6.3)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    // Couriers on top, each with one pip per order in the bag.
    for (const c of this.r.couriers) {
      const world = positions.get(c.index)
      if (!world) continue
      const p = P2(world)
      const isSel = opt.selected === c.index
      const bag = carried.get(c.index) ?? []
      const hasWork = this.activeOrders(c.index, t).length > 0
      ctx.globalAlpha = opt.selected >= 0 && !isSel ? 0.25 : 1
      const at = this.courierAt(c, t)
      if (at.driving && at.a && at.b && at.f !== undefined) {
        ctx.strokeStyle = bag.length > 1 ? pal.stack : pal.ink
        ctx.lineWidth = 2.4 * u
        const base = ctx.globalAlpha
        let prev = p
        for (let k = 1; k <= 4; k++) {
          const back = Math.max(0, at.f - k * 0.035)
          const q = P2(at.poly ? this.polyPoint(at.poly, back) : this.pathPoint(at.a, at.b, back))
          ctx.globalAlpha = base * (0.26 - k * 0.05)
          ctx.beginPath()
          ctx.moveTo(prev.x, prev.y)
          ctx.lineTo(q.x, q.y)
          ctx.stroke()
          prev = q
        }
        ctx.globalAlpha = base
      }
      const r = (isSel ? 7.5 : hasWork ? 5 : 3.2) * u
      ctx.fillStyle = pal.ring
      ctx.beginPath()
      ctx.arc(p.x, p.y, r + 1.6 * u, 0, 6.3)
      ctx.fill()
      ctx.fillStyle = !hasWork ? pal.idle : bag.length > 1 ? pal.stack : pal.ink
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, 6.3)
      ctx.fill()
      bag.forEach((color, i) => {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(bag.length, 3)
        const x = p.x + Math.cos(a) * (r + 3.4 * u)
        const y = p.y + Math.sin(a) * (r + 3.4 * u)
        ctx.fillStyle = pal.ring
        ctx.beginPath()
        ctx.arc(x, y, 3.2 * u, 0, 6.3)
        ctx.fill()
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, y, 2.3 * u, 0, 6.3)
        ctx.fill()
      })
      ctx.globalAlpha = 1
      if (isSel) {
        ctx.strokeStyle = pal.stack
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 7 * u, 0, 6.3)
        ctx.stroke()
        // Numbered stops show the order of the route.
        this.remainingStops(c.index, t).forEach((s, i) => {
          const q = P2(s.p)
          ctx.fillStyle = s.kind === 'pickup' ? pal.ink : pal.stack
          ctx.beginPath()
          ctx.arc(q.x, q.y, 9 * u, 0, 6.3)
          ctx.fill()
          ctx.fillStyle = s.kind === 'pickup' ? pal.ring : '#fff'
          ctx.font = `700 ${Math.round(10.5 * u)}px Figtree, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(i + 1), q.x, q.y + 0.5)
        })
      }
    }
  }

  /** The courier nearest a canvas point, within a finger-sized radius. */
  pick(x: number, y: number, t: number): number {
    let best = -1
    let bestD = 22 * 22
    for (const c of this.r.couriers) {
      if (!this.isOnline(c, t)) continue
      const w = this.courierAt(c, t).p
      const d = (this.sx(w.x, w.y) - x) ** 2 + (this.sy(w.x, w.y) - y) ** 2
      if (d < bestD) { bestD = d; best = c.index }
    }
    return best
  }

  stats(t: number): LiveStats {
    let waiting = 0
    let inBag = 0
    let delivered = 0
    const stacks = new Set<number>()
    for (const o of this.r.orders) {
      if (o.createdAt > t) continue
      if (o.deliveredAt >= 0 && t >= o.deliveredAt) { delivered++; continue }
      if (o.pickedAt >= 0 && t >= o.pickedAt) inBag++
      else waiting++
    }
    let onRoad = 0
    let idle = 0
    for (const c of this.r.couriers) {
      if (!this.isOnline(c, t)) continue
      const active = this.activeOrders(c.index, t)
      if (active.length) onRoad++
      else idle++
      const seen = new Set<number>()
      for (const o of active) {
        if (o.stackId < 0) continue
        if (seen.has(o.stackId)) stacks.add(o.stackId)
        seen.add(o.stackId)
      }
    }
    return { waiting, carried: inBag, delivered, onRoad, idle, stacksLive: stacks.size }
  }
}
