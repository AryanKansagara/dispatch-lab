export interface LatLng { lat: number; lng: number }

/** Input order. Times are minutes from the start of the dataset. */
export interface Order {
  id: string
  createdAt: number
  store: LatLng
  customer: LatLng
  prepMin: number
  /** What dispatch believes prep will take. Defaults to prepMin (a perfect forecast). */
  prepEstMin?: number
  /** Total courier pay if the source data fixes it; otherwise the pay model prices it. */
  payout?: number
  /** Customer tip, used by the pay model when payout is absent. */
  tip?: number
}

export interface Courier {
  id: string
  shiftStart: number
  shiftEnd: number
  start: LatLng
}

export interface Dataset {
  name: string
  synthetic: boolean
  orders: Order[]
  couriers: Courier[]
  /** Clock hour of minute 0, for display only. */
  startHour?: number
  speedMultiplier?: number
}

export interface SimConfig {
  speedKmh: number
  roadFactor: number
  tickMin: number
  pickupMin: number
  dropoffMin: number
  /** Minutes added on top of prep and direct drive to form the delivery promise. */
  promiseBufferMin: number
  maxStack: number
  seed: number
  /** Pay model: max(minBase, basePay + perMile x marginal route miles) + tip. */
  basePay: number
  perMile: number
  minBase: number
  /** Credit the platform pays per order that is badly late or cold. */
  refund: number
  /** An order inside a stack paying under this is flagged as hidden low-pay. */
  lowPayLine: number
}

export const DEFAULT_CONFIG: SimConfig = {
  speedKmh: 24,
  roadFactor: 1.35,
  tickMin: 1,
  pickupMin: 2,
  dropoffMin: 1.5,
  promiseBufferMin: 14,
  maxStack: 3,
  seed: 1,
  basePay: 2,
  perMile: 0.7,
  minBase: 2,
  refund: 4,
  lowPayLine: 4,
}

export type StrategyId = 'greedy' | 'batch' | 'hungarian' | 'optimizer'

export interface StrategySpec {
  id: StrategyId
  /** Optimizer weights, each 0 to 1. */
  batch: number
  fresh: number
  pay: number
}

export interface Stop { kind: 'pickup' | 'dropoff'; order: number; lat: number; lng: number }

export interface OrderState {
  index: number
  src: Order
  createdAt: number
  readyAt: number
  readyEst: number
  promiseAt: number
  /** Direct store-to-customer drive, used for promise and pay. */
  soloMin: number
  assignedAt: number
  pickedAt: number
  deliveredAt: number
  courier: number
  stackId: number
  pay: number
  basePaid: number
  tip: number
  marginalMiles: number
}

/** One courier movement or dwell, in time order. */
export interface Leg {
  t0: number
  t1: number
  from: LatLng
  to: LatLng
  kind: 'drive' | 'wait' | 'service'
}

export interface CourierState {
  index: number
  src: Courier
  online: boolean
  pos: LatLng
  route: Stop[]
  /** The head of the route is locked once the courier is heading to or waiting at it. */
  busyUntil: number
  /** Undelivered orders on the route. */
  load: number
  legs: Leg[]
  activeMin: number
  onlineMin: number
  miles: number
  pay: number
  activeSince: number
  onlineSince: number
  nextEvent: number
}

export interface Quote {
  /** Stops after the insertion, from the current courier position. */
  route: Stop[]
  addedMin: number
  addedMiles: number
  /** Predicted arrival at the store and at the customer for the new order. */
  pickupEta: number
  dropoffEta: number
  /** Total delay pushed onto orders the courier already holds. */
  delayOthers: number
}

export interface DispatchContext {
  now: number
  pending: OrderState[]
  couriers: CourierState[]
  cfg: SimConfig
  quote(c: CourierState, o: OrderState): Quote | null
  /** Minutes for the courier to reach a point from their current position, ignoring their route. */
  minutes(a: LatLng, b: LatLng): number
}

export interface Assignment { courier: number; order: number }
export type Strategy = (ctx: DispatchContext) => Assignment[]
export interface Arm { strategy: Strategy; belongs: (o: OrderState) => boolean }
export type Policy = Strategy | Arm[]

export interface SimResult {
  orders: OrderState[]
  couriers: CourierState[]
  horizon: number
  /** Pending-order count per minute. */
  backlog: number[]
  /** Online couriers per minute. */
  online: number[]
  cfg: SimConfig
}
