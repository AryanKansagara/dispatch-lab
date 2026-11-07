import type { Assignment, Courier, CourierState, Dataset, DispatchContext, LatLng, OrderState, Policy, Quote, SimConfig, SimResult, Stop } from './types.ts'

const EARTH_KM = 6371.0088
const MILE_KM = 1.609344
const RAD = Math.PI / 180

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD
  const dLng = (b.lng - a.lng) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const roadKm = (a: LatLng, b: LatLng, cfg: SimConfig) => haversineKm(a, b) * cfg.roadFactor
export const driveMin = (a: LatLng, b: LatLng, cfg: SimConfig) => (roadKm(a, b, cfg) / cfg.speedKmh) * 60

/** Binary min-heap of events, ties broken by insertion order so runs are deterministic. */
export class EventQueue<T> {
  private items: { t: number; n: number; v: T }[] = []
  private n = 0
  get size() { return this.items.length }
  push(t: number, v: T) {
    const a = this.items
    a.push({ t, n: this.n++, v })
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].t < a[i].t || (a[p].t === a[i].t && a[p].n < a[i].n)) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): { t: number; v: T } | undefined {
    const a = this.items
    if (!a.length) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        const less = (x: number, y: number) => a[x].t < a[y].t || (a[x].t === a[y].t && a[x].n < a[y].n)
        if (l < a.length && less(l, m)) m = l
        if (r < a.length && less(r, m)) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

/** Seeded PRNG (mulberry32), so every run replays exactly. */
export function rngFrom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A second pickup at the same store is one transaction, not two: that is the point of batching. */
const SAME_PLACE_KM = 0.001
const SAME_PLACE_SERVICE = 0.25

type Ev =
  | { k: 'create'; o: number }
  | { k: 'tick' }
  | { k: 'on'; c: number }
  | { k: 'off'; c: number }
  | { k: 'next'; c: number; token: number }

/**
 * Walks a route from a start point and time, returning completion times per stop.
 * Waiting for an unready order uses the dispatch forecast, not the true ready time.
 */
function walk(start: LatLng, t0: number, route: Stop[], orders: OrderState[], cfg: SimConfig): { times: number[]; end: number; km: number } {
  let t = t0
  let km = 0
  let pos = start
  const times: number[] = []
  for (const s of route) {
    const d = roadKm(pos, s, cfg)
    km += d
    t += (d / cfg.speedKmh) * 60
    if (s.kind === 'pickup') t = Math.max(t, orders[s.order].readyEst) + (d < SAME_PLACE_KM ? cfg.pickupMin * SAME_PLACE_SERVICE : cfg.pickupMin)
    else t += cfg.dropoffMin
    times.push(t)
    pos = s
  }
  return { times, end: t, km }
}

/** Cheapest place to insert an order's pickup and dropoff, keeping pickup before dropoff. */
export function bestInsertion(
  start: LatLng, t0: number, route: Stop[], o: OrderState, orders: OrderState[], cfg: SimConfig,
): Quote {
  const pickup: Stop = { kind: 'pickup', order: o.index, lat: o.src.store.lat, lng: o.src.store.lng }
  const dropoff: Stop = { kind: 'dropoff', order: o.index, lat: o.src.customer.lat, lng: o.src.customer.lng }
  const base = walk(start, t0, route, orders, cfg)
  let best: Quote | null = null
  let bestScore = Infinity
  for (let i = 0; i <= route.length; i++) {
    for (let j = i; j <= route.length; j++) {
      const r = [...route.slice(0, i), pickup, ...route.slice(i, j), dropoff, ...route.slice(j)]
      const w = walk(start, t0, r, orders, cfg)
      let delayOthers = 0
      r.forEach((s, k) => {
        const was = route.indexOf(s)
        if (was >= 0 && s.kind === 'dropoff') delayOthers += Math.max(0, w.times[k] - base.times[was])
      })
      const dropoffEta = w.times[j + 1]
      const addedMin = w.end - base.end
      const score = addedMin + delayOthers + (dropoffEta - t0)
      if (score < bestScore) {
        bestScore = score
        best = {
          route: r,
          addedMin,
          addedMiles: Math.max(0, w.km - base.km) / MILE_KM,
          pickupEta: w.times[i],
          dropoffEta,
          delayOthers,
        }
      }
    }
  }
  return best!
}

/**
 * A stack is orders physically in the bag together: their carried intervals overlap on one courier.
 * Being handed a next order while finishing the last one is just a queue, not a stack.
 */
function labelStacks(orders: OrderState[], courierCount: number) {
  const byCourier: OrderState[][] = Array.from({ length: courierCount }, () => [])
  for (const o of orders) if (o.courier >= 0 && o.pickedAt >= 0) byCourier[o.courier].push(o)
  let id = 0
  for (const list of byCourier) {
    list.sort((a, b) => a.pickedAt - b.pickedAt)
    let until = -Infinity
    for (const o of list) {
      if (o.pickedAt >= until) { id++; until = -Infinity }
      o.stackId = id
      until = Math.max(until, o.deliveredAt >= 0 ? o.deliveredAt : Infinity)
    }
  }
}

/**
 * Discrete-event simulator. Orders arrive, prep runs, a policy assigns at each tick, couriers
 * drive multi-stop routes. Time only advances between events.
 *
 * A policy given as arms splits each tick between strategies on one shared fleet. Who decides
 * first alternates by tick so neither arm has standing priority; the shared couriers are exactly
 * where experiment interference comes from.
 */
export function simulate(data: Dataset, policy: Policy, cfg: SimConfig): SimResult {
  const multiplier = data.speedMultiplier ?? 1
  const live: SimConfig = { ...cfg, speedKmh: cfg.speedKmh * multiplier }

  const orders: OrderState[] = data.orders.map((src, index) => {
    const soloMin = driveMin(src.store, src.customer, live)
    const readyAt = src.createdAt + src.prepMin
    return {
      index, src, soloMin, readyAt,
      createdAt: src.createdAt,
      readyEst: src.createdAt + (src.prepEstMin ?? src.prepMin),
      promiseAt: readyAt + soloMin + live.pickupMin + live.dropoffMin + live.promiseBufferMin,
      assignedAt: -1, pickedAt: -1, deliveredAt: -1, courier: -1, stackId: -1,
      pay: 0, basePaid: 0, tip: 0, marginalMiles: 0,
    }
  })
  const couriers: CourierState[] = data.couriers.map((src: Courier, index) => ({
    index, src, online: false, pos: src.start, route: [], busyUntil: 0, load: 0,
    legs: [], activeMin: 0, onlineMin: 0, miles: 0, pay: 0, activeSince: -1, onlineSince: -1, nextEvent: 0,
  }))

  const q = new EventQueue<Ev>()
  orders.forEach(o => q.push(o.createdAt, { k: 'create', o: o.index }))
  couriers.forEach(c => {
    q.push(c.src.shiftStart, { k: 'on', c: c.index })
    q.push(c.src.shiftEnd, { k: 'off', c: c.index })
  })
  q.push(0, { k: 'tick' })

  const lastCreated = orders.reduce((m, o) => Math.max(m, o.createdAt), 0)
  const lastShift = couriers.reduce((m, c) => Math.max(m, c.src.shiftEnd), 0)
  // Anything still undelivered this long after the last order is counted as unfulfilled.
  const hardStop = Math.max(lastCreated, lastShift) + 90

  let pending: OrderState[] = []
  let delivered = 0
  let flip = false
  let now = 0
  let lastEventAt = 0
  const backlog: number[] = []
  const online: number[] = []

  const startMoving = (c: CourierState) => {
    c.nextEvent++
    if (!c.route.length) {
      if (c.activeSince >= 0) { c.activeMin += now - c.activeSince; c.activeSince = -1 }
      c.busyUntil = now
      c.load = 0
      if (now >= c.src.shiftEnd) {
        c.online = false
        if (c.onlineSince >= 0) { c.onlineMin += now - c.onlineSince; c.onlineSince = -1 }
      }
      return
    }
    if (c.activeSince < 0) c.activeSince = now
    const s = c.route[0]
    const d = roadKm(c.pos, s, live)
    const dur = (d / live.speedKmh) * 60
    if (dur > 1e-6) {
      c.legs.push({ t0: now, t1: now + dur, from: c.pos, to: { lat: s.lat, lng: s.lng }, kind: 'drive' })
      c.miles += d / MILE_KM
    }
    c.busyUntil = now + dur
    q.push(now + dur, { k: 'next', c: c.index, token: c.nextEvent })
  }

  const serving = new Set<number>()

  /** When the courier finishes the stop it is locked onto, as far as dispatch can forecast. */
  const headDoneAt = (c: CourierState) => {
    if (!c.route.length) return now
    if (serving.has(c.index)) return c.busyUntil
    const head = c.route[0]
    const arrive = Math.max(now, c.busyUntil)
    return head.kind === 'pickup' ? Math.max(arrive, orders[head.order].readyEst) + live.pickupMin : arrive + live.dropoffMin
  }

  const assign = (a: Assignment) => {
    const o = orders[a.order]
    const c = couriers[a.courier]
    if (o.courier >= 0 || !c.online || now >= c.src.shiftEnd || c.load >= live.maxStack) return
    const locked = c.route.length > 0
    const rest = locked ? c.route.slice(1) : []
    const quote = bestInsertion(locked ? c.route[0] : c.pos, headDoneAt(c), rest, o, orders, live)
    const wasIdle = !locked
    c.route = locked ? [c.route[0], ...quote.route] : quote.route
    o.courier = c.index
    o.assignedAt = now
    c.load++
    o.marginalMiles = quote.addedMiles
    if (o.src.payout !== undefined) {
      o.basePaid = o.src.payout
      o.tip = 0
    } else {
      o.basePaid = Math.max(live.minBase, live.basePay + live.perMile * quote.addedMiles)
      o.tip = o.src.tip ?? 0
    }
    o.pay = o.basePaid + o.tip
    c.pay += o.pay
    pending = pending.filter(p => p !== o)
    if (wasIdle) startMoving(c)
  }

  const quoteFor = (c: CourierState, o: OrderState): Quote | null => {
    if (!c.online || now >= c.src.shiftEnd || c.load >= live.maxStack) return null
    const locked = c.route.length > 0
    return bestInsertion(locked ? c.route[0] : c.pos, headDoneAt(c), locked ? c.route.slice(1) : [], o, orders, live)
  }

  const ctxFor = (subset: OrderState[]): DispatchContext => ({
    now, pending: subset, couriers, cfg: live,
    quote: quoteFor,
    minutes: (a, b) => driveMin(a, b, live),
  })

  const finish = (c: CourierState, s: Stop) => {
    const o = orders[s.order]
    if (s.kind === 'pickup') o.pickedAt = now
    else { o.deliveredAt = now; delivered++; c.load-- }
  }

  /** The courier has arrived at the head of its route. Wait if food is not ready, then serve it. */
  const arrive = (c: CourierState) => {
    const s = c.route[0]
    const samePlace = haversineKm(c.pos, s) < SAME_PLACE_KM && c.legs.length > 0 && c.legs[c.legs.length - 1].kind === 'service'
    c.pos = { lat: s.lat, lng: s.lng }
    if (s.kind === 'pickup') {
      const ready = orders[s.order].readyAt
      if (ready > now + 1e-9) {
        c.legs.push({ t0: now, t1: ready, from: c.pos, to: c.pos, kind: 'wait' })
        c.busyUntil = ready
        c.nextEvent++
        // Re-entering after the wait lands in the service branch below.
        q.push(ready, { k: 'next', c: c.index, token: c.nextEvent })
        return
      }
    }
    const dur = s.kind === 'pickup' ? live.pickupMin * (samePlace ? SAME_PLACE_SERVICE : 1) : live.dropoffMin
    c.legs.push({ t0: now, t1: now + dur, from: c.pos, to: c.pos, kind: 'service' })
    c.busyUntil = now + dur
    c.nextEvent++
    serving.add(c.index)
    q.push(now + dur, { k: 'next', c: c.index, token: c.nextEvent })
  }
  const onNext = (c: CourierState) => {
    if (serving.delete(c.index)) {
      const s = c.route.shift()!
      finish(c, s)
      startMoving(c)
    } else arrive(c)
  }

  const runTick = () => {
    if (!pending.length) return
    if (Array.isArray(policy)) {
      const arms = flip ? [...policy].reverse() : policy
      flip = !flip
      for (const arm of arms) {
        const subset = pending.filter(arm.belongs)
        if (subset.length) for (const a of arm.strategy(ctxFor(subset))) assign(a)
      }
    } else {
      for (const a of policy(ctxFor(pending))) assign(a)
    }
  }

  for (let e = q.pop(); e; e = q.pop()) {
    now = e.t
    if (now > hardStop) break
    for (let m = Math.ceil(lastEventAt); m <= now && m < hardStop; m++) {
      if (backlog.length <= m) {
        backlog[m] = pending.length
        online[m] = couriers.reduce((n, c) => n + (c.online ? 1 : 0), 0)
      }
    }
    lastEventAt = now
    const ev = e.v
    if (ev.k === 'create') pending.push(orders[ev.o])
    else if (ev.k === 'on') {
      const c = couriers[ev.c]
      c.online = true
      c.onlineSince = now
    } else if (ev.k === 'off') {
      const c = couriers[ev.c]
      // A courier finishes the route in hand, then goes offline.
      if (!c.route.length) {
        c.online = false
        c.onlineMin += now - c.onlineSince
        c.onlineSince = -1
      }
    } else if (ev.k === 'next') {
      const c = couriers[ev.c]
      if (ev.token === c.nextEvent) onNext(c)
    } else {
      runTick()
      const anythingLeft = delivered < orders.length && (now < lastCreated || pending.length > 0 || couriers.some(c => c.route.length))
      if (anythingLeft) q.push(now + live.tickMin, { k: 'tick' })
    }
  }

  labelStacks(orders, couriers.length)

  // The replay ends shortly after the last delivery, not when the last empty shift closes.
  const lastDrop = orders.reduce((m, o) => Math.max(m, o.deliveredAt), 0)
  const horizon = delivered === orders.length ? Math.max(lastDrop, lastCreated, 1) : Math.max(now, 1)
  for (const c of couriers) {
    if (c.activeSince >= 0) c.activeMin += now - c.activeSince
    if (c.onlineSince >= 0) c.onlineMin += Math.min(now, c.src.shiftEnd) - c.onlineSince
  }
  return { orders, couriers, horizon, backlog, online, cfg: live }
}
