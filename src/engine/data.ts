import { addressPoints, type CityGeo } from './city.ts'
import { quantile } from './metrics.ts'
import { haversineKm, rngFrom } from './sim.ts'
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
export function generateCity(id: ScenarioId, seed: number, day = 0, city?: CityGeo): Dataset {
  if (city) return generateRealCity(id, seed, day, city)
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

const kmBetween = (a: LatLng, b: LatLng) =>
  Math.hypot((b.lng - a.lng) * 111.32 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 110.574)

/** Address points per city, computed once per worker: sampling the street network is the slow part. */
const addressCache = new WeakMap<CityGeo, LatLng[]>()

/**
 * The same demand model on a real neighbourhood: kitchens are real OpenStreetMap restaurants and
 * customers sit on real residential streets. Volumes, prep times, tips and shifts stay synthetic.
 */
function generateRealCity(id: ScenarioId, seed: number, day: number, city: CityGeo): Dataset {
  const sc = SCENARIOS[id]
  let addresses = addressCache.get(city)
  if (!addresses) { addresses = addressPoints(city); addressCache.set(city, addresses) }
  if (addresses.length < 50) throw new Error(`Too few mapped streets around ${city.name} to place customers.`)
  const geo = rngFrom(seed * 7919 + 13)
  // Which kitchens are busy is the seeded part of the geography: a shuffled subset with a long tail.
  const pool = city.stores.map(s => s)
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(geo() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
  const stores = pool.slice(0, 90).map(([lat, lng, kind], i) => ({ at: { lat, lng }, weight: (kind === 1 ? 1.4 : kind === 2 ? 0.5 : 1) / (1 + i * 0.12) ** 1.1 }))
  const totalWeight = stores.reduce((s, x) => s + x.weight, 0)
  // Customers near each kitchen, found once per store rather than per order.
  const nearCache = new Map<number, LatLng[]>()
  const nearOf = (si: number) => {
    let list = nearCache.get(si)
    if (!list) {
      list = addresses.filter(a => kmBetween(stores[si].at, a) < 1.6)
      if (list.length < 5) list = addresses
      nearCache.set(si, list)
    }
    return list
  }

  const r = rngFrom(seed * 104729 + day * 1299709 + 7)
  const rate = (t: number) => 0.35 + Math.exp(-((t / sc.minutes - sc.peak) ** 2) / (2 * sc.width ** 2))
  const orders: Order[] = []
  const volume = Math.round(sc.orders * (0.94 + r() * 0.12))
  for (let n = 0; orders.length < volume && n < volume * 40; n++) {
    const t = r() * sc.minutes
    if (r() * 1.35 > rate(t)) continue
    let pick = r() * totalWeight
    let si = 0
    for (let i = 0; i < stores.length; i++) { pick -= stores[i].weight; if (pick <= 0) { si = i; break } }
    const list = r() < 0.72 ? nearOf(si) : addresses
    const customer = list[Math.floor(r() * list.length)]
    const prepEst = Math.max(4, Math.exp(Math.log(13) + gauss(r) * 0.4) * sc.prepScale)
    const tipRoll = r()
    orders.push({
      id: '',
      createdAt: t,
      store: stores[si].at,
      customer,
      prepEstMin: prepEst,
      prepMin: Math.max(3, prepEst * Math.exp(gauss(r) * 0.18 + 0.03)),
      tip: tipRoll < 0.18 ? 0 : tipRoll < 0.3 ? 1 + r() * 2 : 3 + -Math.log(1 - r()) * 3.2,
    })
  }
  orders.sort((a, b) => a.createdAt - b.createdAt)
  orders.forEach((o, i) => { o.id = `O${i + 1}` })

  const couriers: Courier[] = Array.from({ length: sc.couriers }, (_, i) => {
    const near = nearOf(Math.floor(r() * Math.min(stores.length, 25)))
    const start = r() * sc.minutes * 0.25 - sc.minutes * 0.05
    return {
      id: `C${i + 1}`,
      shiftStart: Math.max(0, start),
      shiftEnd: Math.min(sc.minutes + 30, Math.max(0, start) + sc.minutes * (0.6 + r() * 0.5)),
      start: near[Math.floor(r() * near.length)],
    }
  })
  return { name: `${sc.label}, ${city.name}`, synthetic: true, orders, couriers, startHour: sc.startHour, speedMultiplier: sc.speed }
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

/**
 * Minutes, "HH:MM", an ISO timestamp, or Unix epoch seconds or milliseconds. Clock values are made
 * relative to the earliest later on. A plain number above 1e8 cannot be minutes into a run (that
 * would be two centuries), so it is read as epoch seconds, and above 1e11 as epoch milliseconds.
 */
export function parseTime(v: unknown): number {
  const s = String(v ?? '').trim()
  if (s === '') return NaN
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return n > 1e11 ? n / 60000 : n > 1e8 ? n / 60 : n
  }
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3] ?? 0) / 60
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? NaN : ms / 60000
}

/** A calendar date as minutes since the Unix epoch (UTC): YYYY-MM-DD, or day first as DD-MM-YYYY or DD/MM/YYYY. */
function parseDate(v: unknown): number {
  const s = String(v ?? '').trim()
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s)
  const [y, m, d] = ymd ? [ymd[1], ymd[2], ymd[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : []
  if (!y || Number(m) > 12 || Number(d) > 31) return NaN
  return Date.UTC(Number(y), Number(m) - 1, Number(d)) / 60000
}

/** Plain numbers, plus labelled ones such as "(min) 24"; "NaN", blank and missing are NaN. */
const num = (v: unknown) => {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim()
  if (s === '') return NaN
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return Number(s)
  const m = /-?\d+(\.\d+)?/.exec(s)
  return m && /[a-z(]/i.test(s) && !/nan/i.test(s) ? Number(m[0]) : NaN
}
const validPos = (lat: number, lng: number) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180

const F = {
  created: ['createdat', 'created', 'createdtime', 'createdmin', 'time', 'ordertime', 'timeorderd', 'timeordered', 'orderedat'],
  date: ['orderdate', 'date'],
  picked: ['timeorderpicked', 'pickedat', 'pickuptime', 'pickedup', 'pickedupat'],
  storeLat: ['storelat', 'storelatitude', 'pickuplat', 'pickuplatitude', 'restaurantlat', 'restaurantlatitude'],
  storeLng: ['storelng', 'storelon', 'storelong', 'storelongitude', 'pickuplng', 'pickuplon', 'pickuplongitude', 'restaurantlng', 'restaurantlon', 'restaurantlongitude'],
  custLat: ['customerlat', 'customerlatitude', 'custlat', 'dropofflat', 'dropofflatitude', 'deliverylat', 'deliverylocationlatitude'],
  custLng: ['customerlng', 'customerlon', 'customerlong', 'customerlongitude', 'custlng', 'custlon', 'dropofflng', 'dropofflon', 'dropofflongitude', 'deliverylng', 'deliverylon', 'deliverylocationlongitude'],
  prep: ['preptime', 'prepmin', 'prep', 'prepminutes', 'preptimemin'],
  payout: ['payout', 'pay', 'courierpay'],
  observed: ['timetakenmin', 'timetaken', 'deliverymin', 'deliveryminutes', 'actualdeliverymin', 'deliverytimemin'],
  shiftStart: ['shiftstart', 'start', 'starttime', 'shiftstartmin'],
  shiftEnd: ['shiftend', 'end', 'endtime', 'shiftendmin'],
  startLat: ['startlat', 'lat', 'startlatitude', 'latitude'],
  startLng: ['startlng', 'startlon', 'lng', 'lon', 'startlongitude', 'longitude'],
}

export interface ParseResult { dataset: Dataset | null; errors: string[]; warnings: string[] }

export const MAX_ORDERS = 5000
const MAX_COURIERS = 800
const MAX_ROWS = 200_000

/**
 * Meituan's public waybill export from the 2025 INFORMS TSL challenge (all_waybill_info_meituan).
 * One row per dispatch offer, so an order appears once per courier it was offered to. Coordinates
 * are degrees times 1e6 and times are Unix seconds in China time (UTC+8).
 */
const MEITUAN_COLS = ['order_id', 'courier_id', 'da_id', 'platform_order_time', 'sender_lat', 'sender_lng', 'recipient_lat', 'recipient_lng', 'estimate_meal_prepare_time']
export const isMeituan = (text: string) => {
  const head = text.slice(0, text.indexOf('\n') >>> 0 || 4000)
  return MEITUAN_COLS.every(c => head.includes(c))
}

/**
 * Cuts a Meituan export to one marketplace: the busiest delivery area on the busiest day, and if
 * that is still over the browser limit, its busiest two clock hours (then one). The full file has
 * about 650,000 offers over 8 days and 23 areas; one area-day is the unit dispatch actually runs on.
 */
export function sliceMeituan(text: string): { text: string; note: string } {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  const head = lines[0].split(',').map(h => h.trim())
  const col = (n: string) => head.indexOf(n)
  const [cDt, cDa, cOrder, cTime] = [col('dt'), col('da_id'), col('order_id'), col('platform_order_time')]
  const orders = new Map<string, Set<string>>()
  const timeOf = new Map<string, number>()
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    const key = `${c[cDt] ?? ''}|${c[cDa]}`
    let set = orders.get(key)
    if (!set) orders.set(key, (set = new Set()))
    set.add(c[cOrder])
    timeOf.set(c[cOrder], Number(c[cTime]))
  }
  let best = ''
  for (const [k, v] of orders) if (!best || v.size > orders.get(best)!.size) best = k
  if (!best) return { text, note: '' }
  let keep = orders.get(best)!
  const [dt, da] = best.split('|')
  let note = `Meituan export: kept delivery area ${da}${dt ? ` on ${dt}` : ''}, the busiest of ${orders.size} area-days`
  for (const hours of [2, 1]) {
    if (keep.size <= MAX_ORDERS) break
    // Hour buckets in local time, UTC+8.
    const hourOf = (id: string) => Math.floor((timeOf.get(id)! + 8 * 3600) / 3600)
    const counts = new Map<number, number>()
    for (const id of keep) counts.set(hourOf(id), (counts.get(hourOf(id)) ?? 0) + 1)
    let start = 0
    let top = -1
    for (const h of counts.keys()) {
      let n = 0
      for (let k = 0; k < hours; k++) n += counts.get(h + k) ?? 0
      if (n > top) { top = n; start = h }
    }
    const window = new Set([...keep].filter(id => hourOf(id) >= start && hourOf(id) < start + hours))
    if (window.size <= MAX_ORDERS || hours === 1) {
      keep = window
      note += `, ${hours === 2 ? 'its busiest two hours' : 'its busiest hour'} from ${String(start % 24).padStart(2, '0')}:00 local time`
    }
  }
  const out = [lines[0], ...lines.slice(1).filter(l => {
    const c = l.split(',')
    return `${c[cDt] ?? ''}|${c[cDa]}` === best && keep.has(c[cOrder])
  })]
  return { text: out.join('\n'), note: `${note}.` }
}

function fromMeituan(recs: Rec[], warnings: string[]): { orders: Order[]; couriers: Courier[]; observed: Map<Order, number> } {
  const s = (r: Rec, k: string) => String(r[k] ?? '')
  const n = (r: Rec, k: string) => Number(r[k] ?? NaN)
  // Keep one row per order: the offer a courier accepted and delivered, else the latest offer.
  const byOrder = new Map<string, Rec>()
  for (const r of recs) {
    const prev = byOrder.get(s(r, 'order_id'))
    const done = (x: Rec) => s(x, 'is_courier_grabbed') === '1' && n(x, 'arrive_time') > 0
    if (!prev || (done(r) && !done(prev))) byOrder.set(s(r, 'order_id'), r)
  }
  const dupes = recs.length - byOrder.size
  const orders: Order[] = []
  const observed = new Map<Order, number>()
  const pending: Order[] = []
  const preps: number[] = []
  let prebook = 0
  for (const [id, r] of byOrder) {
    if (s(r, 'is_prebook') === '1') { prebook++; continue }
    const placed = n(r, 'platform_order_time')
    const ready = n(r, 'estimate_meal_prepare_time')
    const prep = (ready - placed) / 60
    const o: Order = {
      id,
      createdAt: placed / 60,
      store: { lat: n(r, 'sender_lat') / 1e6, lng: n(r, 'sender_lng') / 1e6 },
      customer: { lat: n(r, 'recipient_lat') / 1e6, lng: n(r, 'recipient_lng') / 1e6 },
      prepMin: prep,
    }
    if (!(placed > 0) || !(o.store.lat || o.store.lng) || !(o.customer.lat || o.customer.lng)) continue
    if (prep > 0 && prep <= 120) preps.push(prep)
    else pending.push(o)
    orders.push(o)
    const arrive = n(r, 'arrive_time')
    if (arrive > placed) observed.set(o, (arrive - placed) / 60)
  }
  // Some rows carry a zero or garbled kitchen estimate; give those the area's median.
  const median = preps.length ? [...preps].sort((a, b) => a - b)[Math.floor(preps.length / 2)] : 12
  for (const o of pending) o.prepMin = median
  const grabs = new Map<string, Rec[]>()
  for (const r of byOrder.values()) {
    if (s(r, 'is_courier_grabbed') !== '1' || !(n(r, 'grab_time') > 0) || s(r, 'is_prebook') === '1') continue
    const list = grabs.get(s(r, 'courier_id'))
    if (list) list.push(r)
    else grabs.set(s(r, 'courier_id'), [r])
  }
  const couriers: Courier[] = []
  for (const [id, list] of grabs) {
    list.sort((a, b) => n(a, 'grab_time') - n(b, 'grab_time'))
    const first = list[0]
    const end = Math.max(...list.map(r => Math.max(n(r, 'arrive_time'), n(r, 'grab_time'))))
    const lat = n(first, 'grab_lat') / 1e6 || n(first, 'sender_lat') / 1e6
    const lng = n(first, 'grab_lng') / 1e6 || n(first, 'sender_lng') / 1e6
    couriers.push({ id: `R${id}`, shiftStart: n(first, 'grab_time') / 60, shiftEnd: end / 60 + 1, start: { lat, lng } })
  }
  warnings.push(`Read ${byOrder.size} orders from ${recs.length} dispatch offers${dupes ? ` (${dupes} repeat offers merged)` : ''} and ${couriers.length} couriers who accepted one.`)
  if (prebook) warnings.push(`Pre-booked orders skipped, as they are scheduled rather than on-demand: ${prebook}.`)
  if (pending.length) warnings.push(`Orders with no usable kitchen estimate, given the area median of ${median.toFixed(1)} min: ${pending.length}.`)
  warnings.push('Courier shifts are inferred from their first accepted offer to their last drop-off in this window, so they are shorter than real shifts.')
  return { orders, couriers, observed }
}

/** Parses pasted or uploaded orders and couriers. Bad rows are reported by line and skipped. */
export function parseDataset(ordersText: string, couriersText: string, name = 'Your data'): ParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const meituan = isMeituan(ordersText)
  if (meituan) {
    const cut = sliceMeituan(ordersText)
    ordersText = cut.text
    warnings.push(cut.note)
  }
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
  if (orderRecs.length > MAX_ROWS) return { dataset: null, errors: [`${orderRecs.length} rows is over the ${MAX_ROWS} limit for a browser import. Trim the file to one city first.`], warnings }
  if (courierRecs.length > MAX_COURIERS) return { dataset: null, errors: [`${courierRecs.length} couriers is over the ${MAX_COURIERS} limit.`], warnings }

  const bad: string[] = []
  let parsedOrders: Order[] = []
  let parsedCouriers: Courier[] = []
  let observedOf = new Map<Order, number>()
  if (meituan) {
    const m = fromMeituan(orderRecs, warnings)
    parsedOrders = m.orders
    parsedCouriers = courierRecs.length ? [] : m.couriers
    observedOf = m.observed
  }
  if (!meituan) orderRecs.forEach((rec, i) => {
    const line = i + 2
    let createdAt = parseTime(pickField(rec, F.created))
    const day = parseDate(pickField(rec, F.date))
    // A separate date column turns clock times into absolute ones, so multi-day files sort correctly.
    if (!Number.isNaN(day) && createdAt >= 0 && createdAt < 1440) createdAt += day
    const sLat = num(pickField(rec, F.storeLat))
    const sLng = num(pickField(rec, F.storeLng))
    const cLat = num(pickField(rec, F.custLat))
    const cLng = num(pickField(rec, F.custLng))
    let prep = num(pickField(rec, F.prep))
    if (!Number.isFinite(prep)) {
      // No prep column: the wait from order to pickup is the closest recorded stand-in.
      const picked = parseTime(pickField(rec, F.picked))
      const created = parseTime(pickField(rec, F.created))
      if (Number.isFinite(picked) && Number.isFinite(created)) prep = picked - created + (picked < created && created < 1440 ? 1440 : 0)
    }
    const payout = num(pickField(rec, F.payout))
    const missing = [
      Number.isNaN(createdAt) && 'created time',
      (!Number.isFinite(sLat) || !Number.isFinite(sLng)) && 'store lat/lng',
      (!Number.isFinite(cLat) || !Number.isFinite(cLng)) && 'customer lat/lng',
      (!Number.isFinite(prep) || prep < 0) && 'prep time',
    ].filter(Boolean)
    if (missing.length) { bad.push(`Order line ${line}: bad ${missing.join(', ')}`); return }
    if (!validPos(sLat, sLng) || !validPos(cLat, cLng)) { bad.push(`Order line ${line}: coordinates out of range`); return }
    const o: Order = {
      id: String(pickField(rec, ['id', 'orderid']) ?? `O${i + 1}`),
      createdAt,
      store: { lat: sLat, lng: sLng },
      customer: { lat: cLat, lng: cLng },
      prepMin: prep,
      ...(Number.isFinite(payout) && payout >= 0 ? { payout } : {}),
    }
    parsedOrders.push(o)
    const seen = num(pickField(rec, F.observed))
    if (seen > 0) observedOf.set(o, seen)
  })
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

  // Rows at 0,0 or with the kitchen tens of kilometres from the door are almost always broken
  // coordinates (public delivery datasets have sign flips and zeroed restaurants).
  const before = parsedOrders.length
  parsedOrders = parsedOrders.filter(o => !(o.store.lat === 0 && o.store.lng === 0) && !(o.customer.lat === 0 && o.customer.lng === 0) && haversineKm(o.store, o.customer) <= 50)
  if (parsedOrders.length < before) warnings.push(`${before - parsedOrders.length} orders skipped with the store over 50 km from the customer or at 0,0, which points to broken coordinates.`)
  if (!parsedOrders.length) return { dataset: null, errors: errors.length ? errors : ['No valid orders.'], warnings }

  // One run models one market on one day. A file mixing cities or days keeps its biggest slice.
  const cell = (o: Order) => `${Math.round(o.store.lat * 2)}|${Math.round(o.store.lng * 2)}`
  const cells = new Map<string, number>()
  for (const o of parsedOrders) cells.set(cell(o), (cells.get(cell(o)) ?? 0) + 1)
  if (cells.size > 1) {
    const lats = parsedOrders.map(o => o.store.lat)
    const lngs = parsedOrders.map(o => o.store.lng)
    if (Math.max(...lats) - Math.min(...lats) > 1 || Math.max(...lngs) - Math.min(...lngs) > 1) {
      const top = [...cells].sort((a, b) => b[1] - a[1])[0][0]
      const centre = parsedOrders.find(o => cell(o) === top)!.store
      const kept = parsedOrders.filter(o => haversineKm(o.store, centre) < 60)
      warnings.push(`Orders came from several markets, so only the busiest one was kept: ${kept.length} of ${parsedOrders.length} orders, around ${centre.lat.toFixed(2)}, ${centre.lng.toFixed(2)}.`)
      parsedOrders = kept
      parsedCouriers = parsedCouriers.filter(c => haversineKm(c.start, centre) < 60)
    }
  }
  const spanAll = Math.max(...parsedOrders.map(o => o.createdAt)) - Math.min(...parsedOrders.map(o => o.createdAt))
  if (spanAll > 1440) {
    const days = new Map<number, number>()
    for (const o of parsedOrders) days.set(Math.floor(o.createdAt / 1440), (days.get(Math.floor(o.createdAt / 1440)) ?? 0) + 1)
    const [dayIdx] = [...days].sort((a, b) => b[1] - a[1])[0]
    const total = parsedOrders.length
    parsedOrders = parsedOrders.filter(o => Math.floor(o.createdAt / 1440) === dayIdx)
    parsedCouriers = parsedCouriers.filter(c => c.shiftEnd > dayIdx * 1440 && c.shiftStart < (dayIdx + 1) * 1440)
    const label = dayIdx > 3000 ? ` (${new Date(dayIdx * 86_400_000).toISOString().slice(0, 10)})` : ''
    warnings.push(`Orders span ${days.size} days, so the busiest day${label} was kept: ${parsedOrders.length} of ${total} orders.`)
  }
  if (parsedOrders.length > MAX_ORDERS) return { dataset: null, errors: [`${parsedOrders.length} orders is over the ${MAX_ORDERS} limit for a browser run.`], warnings }

  const observed = parsedOrders.filter(o => observedOf.has(o)).map(o => observedOf.get(o)!)

  // Clock and absolute times become minutes from the first event. Meituan files start on the local hour.
  let t0 = Math.min(...parsedOrders.map(o => o.createdAt), ...parsedCouriers.map(c => c.shiftStart))
  let startHour: number | undefined
  if (meituan) {
    const local = t0 + 8 * 60
    t0 = Math.floor(local / 60) * 60 - 8 * 60
    startHour = Math.floor(local / 60) % 24
  }
  parsedOrders.forEach(o => { o.createdAt -= t0 })
  parsedCouriers.forEach(c => { c.shiftStart = Math.max(0, c.shiftStart - t0); c.shiftEnd -= t0 })
  parsedOrders.sort((a, b) => a.createdAt - b.createdAt)

  const span = Math.max(...parsedOrders.map(o => o.createdAt))
  if (!parsedCouriers.length) {
    // Uniform auto-fleet when none is supplied, upload couriers for real shift patterns.
    const count = Math.max(4, Math.round(parsedOrders.length / 6.5))
    const r = rngFrom(parsedOrders.length)
    for (let i = 0; i < count; i++) {
      const o = parsedOrders[Math.floor(r() * parsedOrders.length)]
      parsedCouriers.push({ id: `C${i + 1}`, shiftStart: 0, shiftEnd: span + 45, start: { ...o.store } })
    }
    warnings.push(`No couriers supplied, so an assumed fleet of ${count} was added, full shift, starting at stores.`)
  }
  const dataset: Dataset = { name: meituan ? 'Meituan waybills' : name, synthetic: false, orders: parsedOrders, couriers: parsedCouriers }
  if (startHour !== undefined) dataset.startHour = startHour
  if (observed.length >= 10) dataset.observed = { deliveryP50: quantile(observed, 0.5), deliveryP90: quantile(observed, 0.9), n: observed.length }
  return { dataset, errors, warnings }
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
