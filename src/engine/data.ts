import { rngFrom } from './sim.ts'
import type { Courier, Dataset, LatLng, Order } from './types.ts'

export type ScenarioId = 'lunch' | 'dinner' | 'rain' | 'shortage'

interface Scenario {
  label: string
  blurb: string
  startHour: number
  minutes: number
  orders: number
  /** Demand peak as a share of the window, and its width. */
  peak: number
  width: number
  couriers: number
  speed: number
  prepScale: number
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  lunch: { label: 'Lunch rush', blurb: 'A short, sharp office-district peak with a balanced fleet.', startHour: 11, minutes: 180, orders: 480, peak: 0.42, width: 0.2, couriers: 88, speed: 1, prepScale: 1 },
  dinner: { label: 'Dinner peak', blurb: 'A long residential evening with the biggest order volume.', startHour: 17, minutes: 240, orders: 780, peak: 0.45, width: 0.24, couriers: 122, speed: 1, prepScale: 1.1 },
  rain: { label: 'Rain', blurb: 'Dinner demand jumps 20% while roads slow by a quarter.', startHour: 17, minutes: 240, orders: 940, peak: 0.45, width: 0.24, couriers: 122, speed: 0.75, prepScale: 1.15 },
  shortage: { label: 'Courier shortage', blurb: 'Dinner demand with a third of the usual fleet missing.', startHour: 17, minutes: 240, orders: 780, peak: 0.45, width: 0.24, couriers: 80, speed: 1, prepScale: 1.1 },
}

/** A fictional city. The coordinates are arbitrary and represent no real place. */
const CENTER: LatLng = { lat: 39.5, lng: -98.35 }
const KM_LAT = 1 / 110.574
const kmLng = (lat: number) => 1 / (111.32 * Math.cos((lat * Math.PI) / 180))
const offset = (x: number, y: number): LatLng => ({ lat: CENTER.lat + y * KM_LAT, lng: CENTER.lng + x * kmLng(CENTER.lat) })

function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
}

/**
 * Seeded synthetic city. The seed fixes the geography; `day` varies only demand and fleet, so a
 * multi-day experiment replays one city rather than a new one each day.
 */
export function generateCity(id: ScenarioId, seed: number, day = 0): Dataset {
  const sc = SCENARIOS[id]
  const geo = rngFrom(seed * 7919 + 13)
  const hubs = Array.from({ length: 5 }, () => ({ x: (geo() - 0.5) * 8, y: (geo() - 0.5) * 8 }))
  const homes = Array.from({ length: 7 }, () => ({ x: (geo() - 0.5) * 10, y: (geo() - 0.5) * 10, s: 0.9 + geo() * 1.2 }))
  const stores = Array.from({ length: 56 }, (_, i) => {
    const h = hubs[i % hubs.length]
    return { at: offset(h.x + gauss(geo) * 0.7, h.y + gauss(geo) * 0.7), weight: 1 / (1 + i * 0.12) ** 1.1, hub: h }
  })
  const totalWeight = stores.reduce((s, x) => s + x.weight, 0)

  const r = rngFrom(seed * 104729 + day * 1299709 + 7)
  // Thinned non-homogeneous arrivals: a uniform base plus a Gaussian peak.
  const rate = (t: number) => 0.35 + Math.exp(-((t / sc.minutes - sc.peak) ** 2) / (2 * sc.width ** 2))
  const orders: Order[] = []
  const volume = Math.round(sc.orders * (0.94 + r() * 0.12))
  for (let n = 0; orders.length < volume && n < volume * 40; n++) {
    const t = r() * sc.minutes
    if (r() * 1.35 > rate(t)) continue
    let pick = r() * totalWeight
    let store = stores[0]
    for (const s of stores) { pick -= s.weight; if (pick <= 0) { store = s; break } }
    // Customers live near a store more often than across town.
    const near = r() < 0.72
    const home = homes[Math.floor(r() * homes.length)]
    const x = near ? store.hub.x + gauss(r) * 1.1 : home.x + gauss(r) * home.s
    const y = near ? store.hub.y + gauss(r) * 1.1 : home.y + gauss(r) * home.s
    const prepEst = Math.max(4, Math.exp(Math.log(13) + gauss(r) * 0.4) * sc.prepScale)
    const tipRoll = r()
    orders.push({
      id: '',
      createdAt: t,
      store: store.at,
      customer: offset(x, y),
      prepEstMin: prepEst,
      // Kitchens run late more often than early, and dispatch only sees the forecast.
      prepMin: Math.max(3, prepEst * Math.exp(gauss(r) * 0.18 + 0.03)),
      tip: tipRoll < 0.18 ? 0 : tipRoll < 0.3 ? 1 + r() * 2 : 3 + -Math.log(1 - r()) * 3.2,
    })
  }
  orders.sort((a, b) => a.createdAt - b.createdAt)
  orders.forEach((o, i) => { o.id = `O${i + 1}` })

  const couriers: Courier[] = Array.from({ length: sc.couriers }, (_, i) => {
    const h = hubs[Math.floor(r() * hubs.length)]
    const start = r() * sc.minutes * 0.25 - sc.minutes * 0.05
    return {
      id: `C${i + 1}`,
      shiftStart: Math.max(0, start),
      shiftEnd: Math.min(sc.minutes + 30, Math.max(0, start) + sc.minutes * (0.6 + r() * 0.5)),
      start: offset(h.x + gauss(r) * 1.6, h.y + gauss(r) * 1.6),
    }
  })
  return { name: sc.label, synthetic: true, orders, couriers, startHour: sc.startHour, speedMultiplier: sc.speed }
}

/** Another plausible day of an uploaded dataset: resample orders and nudge times, keep the fleet. */
export function resampleDay(base: Dataset, seed: number): Dataset {
  const r = rngFrom(seed)
  const orders = base.orders.map((_, i) => {
    const pick = base.orders[Math.floor(r() * base.orders.length)]
    return { ...pick, id: `${pick.id}~${i}`, createdAt: Math.max(0, pick.createdAt + (r() - 0.5) * 10) }
  })
  orders.sort((a, b) => a.createdAt - b.createdAt)
  return { ...base, orders }
}

/** A small RFC-4180 reader: quoted fields, embedded commas, doubled quotes and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      if (row.some(c => c.trim() !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  if (row.some(c => c.trim() !== '')) rows.push(row)
  return rows
}

type Rec = Record<string, unknown>

function recordsFrom(text: string, jsonKey: string): Rec[] {
  const t = text.trim()
  if (!t) return []
  if (t[0] === '{' || t[0] === '[') {
    const parsed: unknown = JSON.parse(t)
    const list = Array.isArray(parsed) ? parsed : (parsed as Rec)[jsonKey]
    if (!Array.isArray(list)) throw new Error(`JSON must be an array or have a "${jsonKey}" array.`)
    return list as Rec[]
  }
  const rows = parseCsv(t)
  const head = rows[0].map(h => h.trim())
  return rows.slice(1).map(cells => Object.fromEntries(head.map((h, i) => [h, cells[i]?.trim() ?? ''])))
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

function pickField(rec: Rec, names: string[]): unknown {
  for (const key of Object.keys(rec)) if (names.includes(norm(key))) return rec[key]
  return undefined
}

/** Minutes, "HH:MM", or an ISO timestamp. Clock values are made relative to the earliest later on. */
function parseTime(v: unknown): number {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim()
  if (s === '') return NaN
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3] ?? 0) / 60
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? NaN : ms / 60000
}

const num = (v: unknown) => (v === undefined || v === '' ? NaN : Number(v))
const validPos = (lat: number, lng: number) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180

const F = {
  created: ['createdat', 'created', 'createdtime', 'createdmin', 'time', 'ordertime'],
  storeLat: ['storelat', 'storelatitude', 'pickuplat'],
  storeLng: ['storelng', 'storelon', 'storelong', 'storelongitude', 'pickuplng', 'pickuplon'],
  custLat: ['customerlat', 'customerlatitude', 'custlat', 'dropofflat'],
  custLng: ['customerlng', 'customerlon', 'customerlong', 'customerlongitude', 'custlng', 'custlon', 'dropofflng', 'dropofflon'],
  prep: ['preptime', 'prepmin', 'prep', 'prepminutes', 'preptimemin'],
  payout: ['payout', 'pay', 'courierpay'],
  shiftStart: ['shiftstart', 'start', 'starttime', 'shiftstartmin'],
  shiftEnd: ['shiftend', 'end', 'endtime', 'shiftendmin'],
  startLat: ['startlat', 'lat', 'startlatitude', 'latitude'],
  startLng: ['startlng', 'startlon', 'lng', 'lon', 'startlongitude', 'longitude'],
}

export interface ParseResult { dataset: Dataset | null; errors: string[]; warnings: string[] }

const MAX_ORDERS = 5000
const MAX_COURIERS = 800

/** Parses pasted or uploaded orders and couriers. Bad rows are reported by line and skipped. */
export function parseDataset(ordersText: string, couriersText: string, name = 'Your data'): ParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  let orderRecs: Rec[] = []
  let courierRecs: Rec[] = []
  try { orderRecs = recordsFrom(ordersText, 'orders') } catch (e) { errors.push(`Orders: ${(e as Error).message}`) }
  if (errors.length) return { dataset: null, errors, warnings }
  try {
    // A single JSON object may hold both lists; couriers stay optional there, as they are everywhere.
    const inline = !couriersText.trim() && ordersText.trim().startsWith('{') && Array.isArray((JSON.parse(ordersText) as Rec).couriers)
    courierRecs = recordsFrom(inline ? ordersText : couriersText, 'couriers')
  } catch (e) { errors.push(`Couriers: ${(e as Error).message}`) }
  if (errors.length) return { dataset: null, errors, warnings }
  if (!orderRecs.length) return { dataset: null, errors: ['No orders found. Paste a CSV with a header row, or JSON.'], warnings }
  if (orderRecs.length > MAX_ORDERS) return { dataset: null, errors: [`${orderRecs.length} orders is over the ${MAX_ORDERS} limit for a browser run.`], warnings }
  if (courierRecs.length > MAX_COURIERS) return { dataset: null, errors: [`${courierRecs.length} couriers is over the ${MAX_COURIERS} limit.`], warnings }

  const bad: string[] = []
  const parsedOrders: Order[] = []
  orderRecs.forEach((rec, i) => {
    const line = i + 2
    const createdAt = parseTime(pickField(rec, F.created))
    const sLat = num(pickField(rec, F.storeLat))
    const sLng = num(pickField(rec, F.storeLng))
    const cLat = num(pickField(rec, F.custLat))
    const cLng = num(pickField(rec, F.custLng))
    const prep = num(pickField(rec, F.prep))
    const payoutRaw = pickField(rec, F.payout)
    const payout = num(payoutRaw)
    const missing = [
      Number.isNaN(createdAt) && 'created time',
      (!Number.isFinite(sLat) || !Number.isFinite(sLng)) && 'store lat/lng',
      (!Number.isFinite(cLat) || !Number.isFinite(cLng)) && 'customer lat/lng',
      (!Number.isFinite(prep) || prep < 0) && 'prep time',
    ].filter(Boolean)
    if (missing.length) { bad.push(`Order line ${line}: bad ${missing.join(', ')}`); return }
    if (!validPos(sLat, sLng) || !validPos(cLat, cLng)) { bad.push(`Order line ${line}: coordinates out of range`); return }
    parsedOrders.push({
      id: String(pickField(rec, ['id', 'orderid']) ?? `O${i + 1}`),
      createdAt,
      store: { lat: sLat, lng: sLng },
      customer: { lat: cLat, lng: cLng },
      prepMin: prep,
      ...(Number.isFinite(payout) && payout >= 0 ? { payout } : {}),
    })
  })
  const parsedCouriers: Courier[] = []
  courierRecs.forEach((rec, i) => {
    const line = i + 2
    const shiftStart = parseTime(pickField(rec, F.shiftStart))
    const shiftEnd = parseTime(pickField(rec, F.shiftEnd))
    const lat = num(pickField(rec, F.startLat))
    const lng = num(pickField(rec, F.startLng))
    if (Number.isNaN(shiftStart) || Number.isNaN(shiftEnd) || !(shiftEnd > shiftStart) || !validPos(lat, lng) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      bad.push(`Courier line ${line}: needs shift start before shift end, and a start position`)
      return
    }
    parsedCouriers.push({ id: String(pickField(rec, ['id', 'courierid']) ?? `C${i + 1}`), shiftStart, shiftEnd, start: { lat, lng } })
  })
  if (bad.length) errors.push(...bad.slice(0, 8), ...(bad.length > 8 ? [`and ${bad.length - 8} more bad rows`] : []))
  if (!parsedOrders.length) return { dataset: null, errors: errors.length ? errors : ['No valid orders.'], warnings }

  // Clock and ISO times become minutes from the first event.
  const t0 = Math.min(...parsedOrders.map(o => o.createdAt), ...parsedCouriers.map(c => c.shiftStart))
  parsedOrders.forEach(o => { o.createdAt -= t0 })
  parsedCouriers.forEach(c => { c.shiftStart -= t0; c.shiftEnd -= t0 })
  parsedOrders.sort((a, b) => a.createdAt - b.createdAt)

  const span = Math.max(...parsedOrders.map(o => o.createdAt))
  const lats = parsedOrders.flatMap(o => [o.store.lat, o.customer.lat])
  const lngs = parsedOrders.flatMap(o => [o.store.lng, o.customer.lng])
  const spreadLat = Math.max(...lats) - Math.min(...lats)
  const spreadLng = Math.max(...lngs) - Math.min(...lngs)
  if (spreadLat > 3 || spreadLng > 3) warnings.push('Orders span over 300 km. This models a single city, so check for swapped lat/lng or mixed markets.')

  if (!parsedCouriers.length) {
    // uniform auto-fleet when none is supplied, upload couriers for real shift patterns.
    const count = Math.max(4, Math.round(parsedOrders.length / 6.5))
    const r = rngFrom(parsedOrders.length)
    for (let i = 0; i < count; i++) {
      const o = parsedOrders[Math.floor(r() * parsedOrders.length)]
      parsedCouriers.push({ id: `C${i + 1}`, shiftStart: 0, shiftEnd: span + 45, start: { ...o.store } })
    }
    warnings.push(`No couriers supplied, so an assumed fleet of ${count} was added, full shift, starting at stores.`)
  }
  return { dataset: { name, synthetic: false, orders: parsedOrders, couriers: parsedCouriers }, errors, warnings }
}

/** The input format, as a runnable CSV pair built from a tiny synthetic city. */
export function sampleCsv(seed = 3): { orders: string; couriers: string } {
  const d = generateCity('lunch', seed)
  const round = (n: number, p = 5) => Number(n.toFixed(p))
  const orders = d.orders.slice(0, 120)
  return {
    orders: ['order_id,created_min,store_lat,store_lng,customer_lat,customer_lng,prep_min,payout',
      ...orders.map(o => [o.id, round(o.createdAt, 1), round(o.store.lat), round(o.store.lng), round(o.customer.lat), round(o.customer.lng), round(o.prepMin, 1), round(3 + (o.tip ?? 0), 2)].join(','))].join('\n'),
    couriers: ['courier_id,shift_start,shift_end,start_lat,start_lng',
      ...d.couriers.slice(0, 20).map(c => [c.id, round(c.shiftStart, 1), round(c.shiftEnd, 1), round(c.start.lat), round(c.start.lng)].join(','))].join('\n'),
  }
}
