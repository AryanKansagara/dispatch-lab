import { FORBIDDEN, hungarian } from './hungarian.ts'
import type { Assignment, CourierState, DispatchContext, OrderState, Strategy, StrategyId, StrategySpec } from './types.ts'

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  greedy: 'Greedy nearest courier',
  batch: 'Batch at same store',
  hungarian: 'Global assignment',
  optimizer: 'Score-weighted optimizer',
}

export const STRATEGY_BLURB: Record<StrategyId, string> = {
  greedy: 'Oldest order first, sent to the closest idle courier. No stacking.',
  batch: 'Holds an order briefly to group it with others at the same store, then sends the group to the closest idle courier.',
  hungarian: 'Each tick, solves a hand-rolled min-cost matching between waiting orders and idle couriers. No stacking.',
  optimizer: 'Prices every order and courier pair, including adding to a live route, then solves the matching. The sliders set the prices.',
}

const idle = (c: CourierState, now: number) => c.online && c.route.length === 0 && c.busyUntil <= now

/** Closest idle courier to each order, oldest order first. */
const greedy: Strategy = ctx => {
  const free = ctx.couriers.filter(c => idle(c, ctx.now))
  const out: Assignment[] = []
  for (const o of [...ctx.pending].sort((a, b) => a.createdAt - b.createdAt)) {
    let best = -1
    let bestMin = Infinity
    free.forEach((c, i) => {
      const m = ctx.minutes(c.pos, o.src.store)
      if (m < bestMin) { bestMin = m; best = i }
    })
    if (best < 0) break
    out.push({ courier: free[best].index, order: o.index })
    free.splice(best, 1)
  }
  return out
}

const storeKey = (o: OrderState) => `${o.src.store.lat.toFixed(4)},${o.src.store.lng.toFixed(4)}`
const HOLD_FOR_BATCH_MIN = 4

/** Group same-store orders, up to the stack limit; a lone order waits a few minutes for company. */
const batchAtStore: Strategy = ctx => {
  const groups = new Map<string, OrderState[]>()
  for (const o of ctx.pending) {
    const key = storeKey(o)
    const g = groups.get(key)
    if (g) g.push(o)
    else groups.set(key, [o])
  }
  const free = ctx.couriers.filter(c => idle(c, ctx.now))
  const out: Assignment[] = []
  const ranked = [...groups.values()].sort((a, b) => a[0].createdAt - b[0].createdAt)
  for (const group of ranked) {
    group.sort((a, b) => a.createdAt - b.createdAt)
    for (let i = 0; i < group.length; i += ctx.cfg.maxStack) {
      const slice = group.slice(i, i + ctx.cfg.maxStack)
      const waited = ctx.now - slice[0].createdAt
      if (slice.length === 1 && waited < HOLD_FOR_BATCH_MIN) continue
      let best = -1
      let bestMin = Infinity
      free.forEach((c, k) => {
        const m = ctx.minutes(c.pos, slice[0].src.store)
        if (m < bestMin) { bestMin = m; best = k }
      })
      if (best < 0) return out
      for (const o of slice) out.push({ courier: free[best].index, order: o.index })
      free.splice(best, 1)
    }
  }
  return out
}

/** Global min-cost matching of waiting orders to idle couriers, one tick at a time. */
const globalAssignment: Strategy = ctx => {
  const free = ctx.couriers.filter(c => idle(c, ctx.now))
  if (!free.length || !ctx.pending.length) return []
  const cost = ctx.pending.map(o => free.map(c => {
    const arrive = ctx.now + ctx.minutes(c.pos, o.src.store)
    // Drive time plus food wait, minus age: with too few couriers the matching would otherwise
    // keep picking easy new orders and strand the far ones forever.
    return (arrive - ctx.now) + Math.max(0, arrive - o.readyEst) - 1.5 * (ctx.now - o.createdAt)
  }))
  const match = hungarian(cost)
  const out: Assignment[] = []
  match.forEach((col, row) => { if (col >= 0) out.push({ courier: free[col].index, order: ctx.pending[row].index }) })
  return out
}

const NEAREST_EACH = 8
/** Caps the matching at the oldest orders in a meltdown, keeps a tick under a few ms. */
const MAX_ORDERS_PER_TICK = 70
const MAX_HOLD_PAST_READY_MIN = 5
/** The most extra minutes a stack may add to any one order, at zero and at full batching weight. */
const MIN_DETOUR = 1.5
const MAX_DETOUR = 16

/** The price of giving this order to this courier, lower is better. FORBIDDEN means not this tick. */
export function offerCost(spec: StrategySpec, ctx: DispatchContext, c: CourierState, o: OrderState): number {
  const q = ctx.quote(c, o)
  if (!q) return FORBIDDEN
  const courierIsIdle = idle(c, ctx.now)
  if (courierIsIdle) {
    // Strategically delay dispatch: do not send a courier who would only stand at the store.
    // A higher batching weight holds longer, which lets stacks form and lets food sit.
    const arrival = ctx.now + ctx.minutes(c.pos, o.src.store)
    if (arrival < o.readyEst + spec.batch * MAX_HOLD_PAST_READY_MIN - 2) return FORBIDDEN
  } else {
    // The batching weight sets how much delay a stack may cost anyone in it.
    const cap = MIN_DETOUR + spec.batch * (MAX_DETOUR - MIN_DETOUR)
    const direct = q.pickupEta + o.soloMin + ctx.cfg.dropoffMin
    if (q.delayOthers > cap || q.dropoffEta - direct > cap) return FORBIDDEN
    if (q.pickupEta - ctx.cfg.pickupMin - o.readyEst > cap + 4) return FORBIDDEN
  }
  const foodWait = Math.max(0, q.pickupEta - ctx.cfg.pickupMin - o.readyEst)
  const quality = q.dropoffEta - o.createdAt + q.delayOthers + 1.5 * foodWait
  // The insertion is what prices a stacked order: a cheap detour earns almost no base pay.
  const pay = o.src.payout ?? Math.max(ctx.cfg.minBase, ctx.cfg.basePay + ctx.cfg.perMile * q.addedMiles) + (o.src.tip ?? 0)
  const lowPay = Math.max(0, ctx.cfg.lowPayLine + 2 - pay)
  // Quality already counts an old order's age against it, so without this credit the matching would
  // prefer fresh orders whenever orders outnumber couriers and strand the oldest forever.
  const ageCredit = (spec.fresh + 1) * (ctx.now - o.createdAt)
  return spec.batch * 3 * q.addedMin + spec.fresh * quality + spec.pay * 8 * lowPay - ageCredit
}

/** Scores every pair, then solves one global matching per tick. */
const optimizer = (spec: StrategySpec): Strategy => ctx => {
  const orders = [...ctx.pending].sort((a, b) => a.createdAt - b.createdAt).slice(0, MAX_ORDERS_PER_TICK)
  const couriers = ctx.couriers.filter(c => c.online && c.load < ctx.cfg.maxStack)
  if (!orders.length || !couriers.length) return []
  // Prices only the nearest busy and nearest idle couriers per order, widen if routes look myopic.
  const cost = orders.map(o => {
    const ranked = couriers
      .map((c, i) => ({ i, m: ctx.minutes(c.pos, o.src.store), free: idle(c, ctx.now) }))
      .sort((x, y) => x.m - y.m)
    // Idle couriers always get a look: a ring of over-capacity busy ones must not strand an order.
    const near = [...ranked.filter(x => x.free).slice(0, NEAREST_EACH), ...ranked.filter(x => !x.free).slice(0, NEAREST_EACH)]
    const row = new Array<number>(couriers.length).fill(FORBIDDEN)
    for (const { i } of near) row[i] = offerCost(spec, ctx, couriers[i], o)
    return row
  })
  const match = hungarian(cost)
  const out: Assignment[] = []
  match.forEach((col, row) => {
    if (col >= 0 && cost[row][col] < FORBIDDEN) out.push({ courier: couriers[col].index, order: orders[row].index })
  })
  return out
}

export function makeStrategy(spec: StrategySpec): Strategy {
  if (spec.id === 'greedy') return greedy
  if (spec.id === 'batch') return batchAtStore
  if (spec.id === 'hungarian') return globalAssignment
  return optimizer(spec)
}
