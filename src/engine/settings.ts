import { parseCityKey } from './city.ts'
import type { ScenarioId } from './data.ts'
import { SCENARIOS } from './data.ts'
import { DEFAULT_CONFIG, type SimConfig, type StrategyId, type StrategySpec } from './types.ts'

export type Tab = 'replay' | 'experiment' | 'sweep' | 'data'

export interface Settings {
  scenario: ScenarioId | 'custom'
  /** 'grid' for the fictional city, a preset id, or a searched place (see parseCityKey). */
  city: string
  seed: number
  a: StrategySpec
  b: StrategySpec
  compare: boolean
  maxStack: number
  speedKmh: number
  roadFactor: number
  tab: Tab
  days: number
  regions: number
  windowMin: number
}

export const DEFAULT_SETTINGS: Settings = {
  scenario: 'dinner',
  city: 'toronto',
  seed: 7,
  a: { id: 'optimizer', batch: 0.15, fresh: 0.5, pay: 0 },
  b: { id: 'optimizer', batch: 0.85, fresh: 0.5, pay: 0 },
  compare: true,
  maxStack: DEFAULT_CONFIG.maxStack,
  speedKmh: DEFAULT_CONFIG.speedKmh,
  roadFactor: DEFAULT_CONFIG.roadFactor,
  tab: 'replay',
  days: 6,
  regions: 2,
  windowMin: 30,
}

const IDS: StrategyId[] = ['greedy', 'batch', 'hungarian', 'optimizer']
const TABS: Tab[] = ['replay', 'experiment', 'sweep', 'data']

const pct = (x: number) => Math.round(x * 100)
const encodeSpec = (s: StrategySpec) => `${s.id}.${pct(s.batch)}.${pct(s.fresh)}.${pct(s.pay)}`

function decodeSpec(raw: string | null, fallback: StrategySpec): StrategySpec {
  if (!raw) return fallback
  const [id, b, f, p] = raw.split('.')
  if (!IDS.includes(id as StrategyId)) return fallback
  const unit = (v: string, d: number) => {
    const n = Number(v) / 100
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d
  }
  return { id: id as StrategyId, batch: unit(b, fallback.batch), fresh: unit(f, fallback.fresh), pay: unit(p, fallback.pay) }
}

export function encodeSettings(s: Settings): string {
  return new URLSearchParams({
    s: s.scenario,
    city: s.city,
    seed: String(s.seed),
    a: encodeSpec(s.a),
    b: encodeSpec(s.b),
    cmp: s.compare ? '1' : '0',
    stack: String(s.maxStack),
    speed: String(s.speedKmh),
    road: String(s.roadFactor),
    tab: s.tab,
    days: String(s.days),
    rg: String(s.regions),
    w: String(s.windowMin),
  }).toString()
}

/** A shared link is untrusted input: every field is range-checked and falls back on its default. */
export function decodeSettings(hash: string, base: Settings = DEFAULT_SETTINGS): Settings {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const num = (key: string, lo: number, hi: number, d: number) => {
    const raw = q.get(key)
    if (raw === null || raw === '') return d
    const n = Number(raw)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
  }
  const sc = q.get('s')
  const tab = q.get('tab') as Tab
  return {
    scenario: sc && (sc in SCENARIOS || sc === 'custom') && Object.hasOwn({ ...SCENARIOS, custom: 1 }, sc) ? (sc as Settings['scenario']) : base.scenario,
    city: parseCityKey(q.get('city')) ? q.get('city')! : base.city,
    seed: Math.round(num('seed', 1, 999999, base.seed)),
    a: decodeSpec(q.get('a'), base.a),
    b: decodeSpec(q.get('b'), base.b),
    compare: q.has('cmp') ? q.get('cmp') === '1' : base.compare,
    maxStack: Math.round(num('stack', 1, 4, base.maxStack)),
    speedKmh: num('speed', 5, 80, base.speedKmh),
    roadFactor: num('road', 1, 2.5, base.roadFactor),
    tab: TABS.includes(tab) ? tab : base.tab,
    days: Math.round(num('days', 2, 30, base.days)),
    regions: Math.round(num('rg', 1, 4, base.regions)),
    windowMin: Math.round(num('w', 10, 120, base.windowMin)),
  }
}

export const configOf = (s: Pick<Settings, 'maxStack' | 'speedKmh' | 'roadFactor' | 'seed'>): SimConfig => ({
  ...DEFAULT_CONFIG, maxStack: s.maxStack, speedKmh: s.speedKmh, roadFactor: s.roadFactor, seed: s.seed,
})
