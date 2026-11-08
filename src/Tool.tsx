import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react'
import { CoolingChart, EstimateChart, FrontierChart, Histogram, LineChart, PowerChart, SwitchbackGrid, TradeoffTriangle } from './Charts.tsx'
import { startTask, useRun, type ExperimentOutput, type Request, type Source, type SweepOutput } from './client.ts'
import { loadCity, searchPlaces, useCity, type Place } from './cities.ts'
import { Clock, clockLabel } from './clock.ts'
import { cityLabel, parseCityKey, PRESETS, searchedKey, type CityGeo } from './engine/city.ts'
import { parseDataset, sampleCsv, SCENARIOS, type ScenarioId } from './engine/data.ts'
import { daysForPower, OUTCOMES, powerAt, type OutcomeId } from './engine/experiment.ts'
import { quantile, stacksOf, tempAt, type Metrics } from './engine/metrics.ts'
import { configOf, decodeSettings, DEFAULT_SETTINGS, encodeSettings, type Settings, type Tab } from './engine/settings.ts'
import { STRATEGY_BLURB, STRATEGY_LABEL } from './engine/strategies.ts'
import type { Dataset, OrderState, SimResult, StrategyId, StrategySpec } from './engine/types.ts'
import { CityMap, Footer, HeatLegend, Link, Monogram, prefersReducedMotion, Slider, SyntheticBadge, ThemeToggle } from './shared.tsx'

const SETTINGS_KEY = 'dispatch-lab-settings'
const DATA_KEY = 'dispatch-lab-dataset'

const labelOf = (s: StrategySpec) => (s.id === 'optimizer' ? `Optimizer, batching ${Math.round(s.batch * 100)}` : STRATEGY_LABEL[s.id])
const pct = (v: number) => `${Math.round(v * 100)}%`
const money = (v: number) => `$${v.toFixed(2)}`
const fixed1 = (v: number) => v.toFixed(1)

function loadInitial(): Settings {
  let base = DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) base = decodeSettings(raw, DEFAULT_SETTINGS)
  } catch { /* Private browsing: start from defaults. */ }
  return location.hash.length > 1 ? decodeSettings(location.hash, base) : base
}

function loadDataset(): Dataset | null {
  try {
    const raw = localStorage.getItem(DATA_KEY)
    return raw ? (JSON.parse(raw) as Dataset) : null
  } catch { return null }
}

export default function Tool() {
  const [s, setS] = useState<Settings>(loadInitial)
  const [dataset, setDataset] = useState<Dataset | null>(loadDataset)
  const [toast, setToast] = useState('')
  const update = (patch: Partial<Settings>) => setS(prev => ({ ...prev, ...patch }))

  useEffect(() => {
    const encoded = encodeSettings(s)
    history.replaceState(null, '', `${location.pathname}${location.search}#${encoded}`)
    try { localStorage.setItem(SETTINGS_KEY, encoded) } catch { /* Storage full: the URL still holds state. */ }
  }, [s])

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(''), 2800)
    return () => clearTimeout(id)
  }, [toast])

  const useCustom = s.scenario === 'custom'
  const cityState = useCity(s.city)
  const cityPending = !useCustom && (cityState.loading || !!cityState.error)
  const source: Source | null = useCustom
    ? (dataset ? { kind: 'data', dataset } : null)
    : cityPending ? null : { kind: 'scenario', id: s.scenario as ScenarioId, seed: s.seed, city: cityState.city ?? undefined }
  const sourceKey = useCustom ? `custom/${dataset?.name}/${dataset?.orders.length}/${dataset?.couriers.length}` : `${s.city}/${s.scenario}/${s.seed}`
  const cfg = configOf(s)
  const cfgKey = `${s.maxStack}/${s.speedKmh}/${s.roadFactor}`
  const startHour = useCustom ? undefined : SCENARIOS[s.scenario as ScenarioId].startHour

  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setToast(useCustom ? 'Link copied. Uploaded data stays in this browser, so the link carries settings only.' : 'Link copied, with settings and seed.')
    } catch { setToast('Copy failed. The address bar already holds the full link.') }
  }

  const tabs: [Tab, string][] = [['replay', 'Replay'], ['experiment', 'Experiment'], ['sweep', 'Sweep'], ['data', 'Your data']]

  return (
    <div className="tool">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Dispatch Lab home"><Monogram /><strong>Dispatch Lab</strong></Link>
        <nav className="tabs" aria-label="Sections">
          {tabs.map(([id, name]) => (
            <button key={id} type="button" className={s.tab === id ? 'tab on' : 'tab'} aria-current={s.tab === id ? 'page' : undefined} onClick={() => update({ tab: id })}>{name}</button>
          ))}
        </nav>
        <div className="topbar-right">
          <button className="btn btn-quiet btn-small" type="button" onClick={share}>Share</button>
          <ThemeToggle />
        </div>
      </header>

      <div className="scenario-bar">
        {!useCustom && <CityPicker value={s.city} onChange={city => update({ city })} />}
        <div className="pills" role="group" aria-label="City scenario">
          {(Object.keys(SCENARIOS) as ScenarioId[]).map(id => (
            <button key={id} type="button" className={s.scenario === id ? 'pill on' : 'pill'} aria-pressed={s.scenario === id} title={SCENARIOS[id].blurb} onClick={() => update({ scenario: id })}>{SCENARIOS[id].label}</button>
          ))}
          <button type="button" className={useCustom ? 'pill on' : 'pill'} aria-pressed={useCustom} onClick={() => update(dataset ? { scenario: 'custom' } : { scenario: 'custom', tab: 'data' })}>Your data</button>
        </div>
        {!useCustom && (
          <label className="seed">
            <span>Seed</span>
            <input type="number" min={1} max={999999} value={s.seed} onChange={e => {
              const n = Math.round(Number(e.target.value))
              if (n >= 1 && n <= 999999) update({ seed: n })
            }} />
            <button type="button" className="icon-btn small" aria-label="Random seed" title="Random seed" onClick={() => update({ seed: 1 + Math.floor(Math.random() * 9999) })}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm2 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-4-4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" /></svg>
            </button>
          </label>
        )}
        {useCustom ? <span className="badge badge-yours"><i aria-hidden="true" />Your data, local to this browser</span> : <SyntheticBadge text={s.city === 'grid' ? 'Synthetic city, not DoorDash data' : 'Real streets, synthetic orders'} />}
      </div>

      <main className="tool-main">
        {cityPending && s.tab !== 'data' ? <CityStatus cityKey={s.city} error={cityState.error} onGrid={() => update({ city: 'grid' })} onPreset={() => update({ city: 'toronto' })} /> : <>
          {s.tab === 'replay' && <ReplayView s={s} update={update} source={source} sourceKey={sourceKey} cfg={cfg} cfgKey={cfgKey} startHour={startHour} />}
          {s.tab === 'experiment' && (source ? <ExperimentView s={s} update={update} source={source} sourceKey={sourceKey} cfgKey={cfgKey} /> : <NeedData update={update} />)}
          {s.tab === 'sweep' && (source ? <SweepView s={s} update={update} source={source} sourceKey={sourceKey} cfgKey={cfgKey} /> : <NeedData update={update} />)}
        </>}
        {s.tab === 'data' && <DataView dataset={dataset} onLoad={d => {
          setDataset(d)
          try {
            if (d) localStorage.setItem(DATA_KEY, JSON.stringify(d))
            else localStorage.removeItem(DATA_KEY)
          } catch { setToast('This dataset is too big to remember across reloads, but it works for this session.') }
          update(d ? { scenario: 'custom', tab: 'replay' } : { scenario: 'dinner' })
        }} />}
      </main>
      <Footer />
      <div className={toast ? 'toast show' : 'toast'} role="status" aria-live="polite">{toast}</div>
    </div>
  )
}

const cityOf = (source: Source | null): CityGeo | null => (source?.kind === 'scenario' ? source.city ?? null : null)

/** Ready-made cities load instantly; search reaches any place OpenStreetMap knows. */
function CityPicker({ value, onChange }: { value: string; onChange(key: string): void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Place[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const searched = parseCityKey(value)?.kind === 'search'
  const search = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (q.trim().length < 2) return
    setBusy(true)
    setError('')
    try {
      const list = await searchPlaces(q.trim())
      setResults(list)
      if (!list.length) setError('No places found. Try a city name.')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    setBusy(false)
  }
  // Warm the cache for the city a visitor is most likely to pick next.
  useEffect(() => { void loadCity('toronto').catch(() => {}) }, [])
  return (
    <div className="city-picker">
      <label className="city-select">
        <span>City</span>
        <select value={value} onChange={e => e.target.value === '__search' ? setOpen(true) : onChange(e.target.value)}>
          {PRESETS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          {searched && <option value={value}>{cityLabel(value)}</option>}
          <option value="grid">Fictional grid city</option>
          <option value="__search">Search any city...</option>
        </select>
      </label>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen(o => !o)} aria-expanded={open}>Search</button>
      {open && (
        <div className="city-search" role="dialog" aria-label="Search for a city" onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
          <form onSubmit={search}>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="City or neighbourhood, e.g. Brooklyn" aria-label="City or neighbourhood" />
            <button className="btn btn-red btn-small" type="submit" disabled={busy}>{busy ? 'Searching' : 'Find'}</button>
          </form>
          {error && <p className="city-error">{error}</p>}
          {results && results.length > 0 && (
            <ul>
              {results.map(p => (
                <li key={`${p.center.lat},${p.center.lng}`}>
                  <button type="button" onClick={() => { onChange(searchedKey(p.name, p.center)); setOpen(false); setResults(null); setQ('') }}>
                    <b>{p.name}</b><span>{p.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="city-note">Restaurants and streets within 3 km of the centre come live from OpenStreetMap. A new place can take up to a minute; ready-made cities load instantly.</p>
        </div>
      )}
    </div>
  )
}

function CityStatus({ cityKey, error, onGrid, onPreset }: { cityKey: string; error: string; onGrid(): void; onPreset(): void }) {
  const name = cityLabel(cityKey)
  if (!error) return (
    <div className="empty" role="status">
      <span className="spinner" />
      <h2>Loading {name}</h2>
      <p>{parseCityKey(cityKey)?.kind === 'search' ? 'Fetching restaurants and streets from OpenStreetMap. A new place can take up to a minute.' : 'Loading real streets and restaurants.'}</p>
    </div>
  )
  return (
    <div className="empty" role="alert">
      <h2>Could not load {name}</h2>
      <p>{error}</p>
      <div className="hero-cta">
        <button type="button" className="btn btn-red" onClick={onPreset}>Use Toronto</button>
        <button type="button" className="btn btn-quiet" onClick={onGrid}>Use the fictional city</button>
      </div>
    </div>
  )
}

function NeedData({ update }: { update(p: Partial<Settings>): void }) {
  return (
    <div className="empty">
      <h2>No dataset loaded yet</h2>
      <p>Paste or upload your orders, or pick one of the synthetic cities above.</p>
      <button type="button" className="btn btn-red" onClick={() => update({ tab: 'data' })}>Add your data</button>
    </div>
  )
}

function StrategyCard({ tag, cls, spec, onChange }: { tag: string; cls: string; spec: StrategySpec; onChange(s: StrategySpec): void }) {
  return (
    <section className={`card strategy ${cls}`}>
      <label className="strategy-head">
        <span className="tag">{tag}</span>
        <select value={spec.id} aria-label={`Strategy ${tag}`} onChange={e => onChange({ ...spec, id: e.target.value as StrategyId })}>
          {(Object.keys(STRATEGY_LABEL) as StrategyId[]).map(id => <option key={id} value={id}>{STRATEGY_LABEL[id]}</option>)}
        </select>
      </label>
      <p className="muted small">{STRATEGY_BLURB[spec.id]}</p>
      {spec.id === 'optimizer' && (
        <div className="sliders">
          <Slider label="Batching weight" value={spec.batch} format={pct} onChange={batch => onChange({ ...spec, batch })} />
          <Slider label="Food quality weight" value={spec.fresh} format={pct} onChange={fresh => onChange({ ...spec, fresh })} />
          <Slider label="Courier pay floor weight" value={spec.pay} format={pct} onChange={pay => onChange({ ...spec, pay })} />
        </div>
      )}
    </section>
  )
}

function Transport({ clock, backlog, startHour }: { clock: Clock; backlog: number[]; startHour?: number }) {
  const [, force] = useState(0)
  const last = useRef(0)
  useEffect(() => clock.subscribe(() => {
    const now = performance.now()
    if (!clock.playing || now - last.current > 90) { last.current = now; force(n => n + 1) }
  }), [clock])
  const peak = Math.max(1, ...backlog)
  const spark = backlog.length > 1
    ? `M0,30 ${backlog.map((v, i) => `L${((i / (backlog.length - 1)) * 100).toFixed(2)},${(30 - (v / peak) * 28).toFixed(1)}`).join(' ')} L100,30 Z`
    : ''
  return (
    <div className="transport">
      <button type="button" className="play" aria-label={clock.playing ? 'Pause' : 'Play'} title="Space" onClick={() => clock.toggle()}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
          {clock.playing ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5l11 7-11 7z" />}
        </svg>
      </button>
      <div className="scrub">
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d={spark} /></svg>
        <input
          type="range" min={0} max={clock.horizon} step={0.5} value={clock.t} aria-label="Timeline"
          aria-valuetext={clockLabel(clock.t, startHour)}
          style={{ '--pct': `${(clock.t / clock.horizon) * 100}%` } as React.CSSProperties}
          onChange={e => clock.seek(Number(e.target.value))}
        />
      </div>
      <span className="transport-time">{clockLabel(clock.t, startHour)}</span>
      <div className="pills tight" role="group" aria-label="Playback speed">
        {[2, 4, 8, 16].map(v => (
          <button key={v} type="button" className={clock.speed === v ? 'pill on' : 'pill'} aria-pressed={clock.speed === v} onClick={() => { clock.speed = v; clock.notify() }}>{v / 2}x</button>
        ))}
      </div>
    </div>
  )
}

interface Row { label: string; get(m: Metrics): number; f(v: number): string; better: 'low' | 'high' | 'none'; group: string; hideZero?: boolean }
const ROWS: Row[] = [
  { group: 'Batching efficiency', label: 'Orders in stacks', get: m => m.stackShare, f: pct, better: 'none' },
  { group: 'Batching efficiency', label: 'Courier minutes per delivery', get: m => m.courierMinPerDelivery, f: fixed1, better: 'low' },
  { group: 'Batching efficiency', label: 'Miles per delivery', get: m => m.milesPerDelivery, f: v => v.toFixed(2), better: 'low' },
  { group: 'Batching efficiency', label: 'Courier utilization', get: m => m.utilization, f: pct, better: 'none' },
  { group: 'Batching efficiency', label: 'Platform cost per delivery', get: m => m.platformCost, f: money, better: 'low' },
  { group: 'Food quality', label: 'Delivery time, p50 (min)', get: m => m.deliveryP50, f: fixed1, better: 'low' },
  { group: 'Food quality', label: 'Delivery time, p90 (min)', get: m => m.deliveryP90, f: fixed1, better: 'low' },
  { group: 'Food quality', label: 'Food wait after ready (min)', get: m => m.foodWaitMean, f: fixed1, better: 'low' },
  { group: 'Food quality', label: 'Temperature at the door', get: m => m.tempMean, f: v => `${v.toFixed(1)}°C`, better: 'high' },
  { group: 'Food quality', label: 'Arrives cold', get: m => m.coldRate, f: pct, better: 'low' },
  { group: 'Food quality', label: 'Late rate', get: m => m.lateRate, f: pct, better: 'low' },
  { group: 'Food quality', label: 'Never delivered', get: m => m.unfulfilledRate, f: pct, better: 'low' },
  { group: 'Courier pay', label: 'Pay per active hour', get: m => m.payPerActiveHour, f: money, better: 'high' },
  { group: 'Courier pay', label: 'Pay per online hour', get: m => m.payPerOnlineHour, f: money, better: 'high' },
  { group: 'Courier pay', label: 'Pay per mile', get: m => m.payPerMile, f: money, better: 'high' },
  { group: 'Courier pay', label: 'Worst-paid order in a stack', get: m => m.worstStackPay, f: v => (v ? money(v) : 'No stacks'), better: 'high', hideZero: true },
  { group: 'Courier pay', label: 'Typical lowest order per stack', get: m => m.medianLowestInStack, f: v => (v ? money(v) : 'No stacks'), better: 'high', hideZero: true },
  { group: 'Courier pay', label: 'Stacks hiding an order under $4', get: m => m.hiddenLowPayRate, f: pct, better: 'low' },
]

function MetricsTable({ a, b, labelA, labelB }: { a: Metrics; b?: Metrics; labelA: string; labelB?: string }) {
  const groups = [...new Set(ROWS.map(r => r.group))]
  return (
    <div className="table-wrap">
      <table className="metrics">
        <thead>
          <tr><th scope="col">Metric</th><th scope="col" className="num"><span className="tag a">A</span> {labelA}</th>{b && <><th scope="col" className="num"><span className="tag b">B</span> {labelB}</th><th scope="col" className="num">B against A</th></>}</tr>
        </thead>
        {groups.map(g => (
          <tbody key={g}>
            <tr className="group"><th colSpan={b ? 4 : 2} scope="colgroup">{g}</th></tr>
            {ROWS.filter(r => r.group === g).map(r => {
              const va = r.get(a)
              const vb = b ? r.get(b) : 0
              const d = vb - va
              const comparable = !(r.hideZero && (!va || !vb))
              const flat = r.f === pct ? Math.abs(d) < 0.005 : Math.abs(d) < 1e-6 || (Math.abs(va) > 1e-9 && Math.abs(d / va) < 0.005)
              const good = r.better === 'none' || flat ? 'flat' : (r.better === 'low') === d < 0 ? 'good' : 'bad'
              return (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className="num">{r.f(va)}</td>
                  {b && <td className="num">{r.f(vb)}</td>}
                  {b && (
                    <td className={`num delta ${comparable ? good : 'flat'}`}>
                      {!comparable ? 'n/a' : flat ? 'Same' : <>
                        <span aria-hidden="true">{d > 0 ? '▲' : '▼'}</span> {r.f === pct ? `${d > 0 ? '+' : ''}${Math.round(d * 100)} pts` : va ? `${d > 0 ? '+' : ''}${Math.round((d / Math.abs(va)) * 100)}%` : r.f(Math.abs(d))}
                        {good !== 'flat' && <span className="sr">{good === 'good' ? ', better' : ', worse'}</span>}
                      </>}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        ))}
      </table>
    </div>
  )
}

/** Plain-language summary of the trade-off between the two running strategies. */
function verdict(a: Metrics, b: Metrics, labelB: string): ReactNode {
  const eff = (b.courierMinPerDelivery - a.courierMinPerDelivery) / a.courierMinPerDelivery
  const temp = b.tempMean - a.tempMean
  const p50 = b.deliveryP50 - a.deliveryP50
  const pay = b.payPerActiveHour - a.payPerActiveHour
  const direction = (v: number, up: string, down: string) => (v >= 0 ? up : down)
  return (
    <>
      <strong>{labelB}</strong> uses <b>{Math.abs(Math.round(eff * 100))}% {direction(eff, 'more', 'fewer')}</b> courier minutes per delivery,
      {' '}delivers food <b>{Math.abs(temp).toFixed(1)}&deg;C {direction(temp, 'hotter', 'colder')}</b> and <b>{Math.abs(p50).toFixed(1)} min {direction(p50, 'slower', 'faster')}</b> at the median,
      {' '}and pays couriers <b>{money(Math.abs(pay))} {direction(pay, 'more', 'less')}</b> per active hour.
      {b.hiddenLowPayRate > 0 && <> {pct(b.hiddenLowPayRate)} of its stacks hide an order paying under $4.</>}
    </>
  )
}

const scoreEfficiency = (m: Metrics) => (26 - m.courierMinPerDelivery) / 12
const scoreFood = (m: Metrics) => (m.tempMean - 46) / 16
const scorePay = (m: Metrics) => (m.payPerActiveHour - 16) / 20

function ReplayView({ s, update, source, sourceKey, cfg, cfgKey, startHour }: {
  s: Settings; update(p: Partial<Settings>): void; source: Source | null; sourceKey: string; cfg: ReturnType<typeof configOf>; cfgKey: string; startHour?: number
}) {
  const clock = useMemo(() => new Clock(), [])
  const reqA: Request | null = source && { kind: 'run', source, spec: s.a, cfg }
  const reqB: Request | null = source && s.compare ? { kind: 'run', source, spec: s.b, cfg } : null
  const runA = useRun(reqA, reqA ? `${sourceKey}/${cfgKey}/${JSON.stringify(s.a)}` : '')
  const runB = useRun(reqB, reqB ? `${sourceKey}/${cfgKey}/${JSON.stringify(s.b)}` : '')
  const a = runA.data
  const b = s.compare ? runB.data : null
  const [selected, setSelected] = useState<{ side: 'a' | 'b'; index: number } | null>(null)

  useEffect(() => { setSelected(null) }, [sourceKey])
  useEffect(() => {
    const h = Math.max(a?.result.horizon ?? 1, b?.result.horizon ?? 1)
    clock.setHorizon(h)
  }, [a, b, clock])

  const started = useRef(false)
  useEffect(() => {
    if (!a || started.current) return
    started.current = true
    clock.t = Math.min(40, a.result.horizon * 0.2)
    if (prefersReducedMotion()) clock.notify()
    else clock.play()
  }, [a, clock])
  useEffect(() => () => clock.pause(), [clock])

  // Space plays and pauses, arrows scrub. Never while typing or using a form control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, select, textarea, button, a')) return
      if (e.code === 'Space') { e.preventDefault(); clock.toggle() }
      else if (e.key === 'ArrowRight') clock.seek(clock.t + (e.shiftKey ? 15 : 3))
      else if (e.key === 'ArrowLeft') clock.seek(clock.t - (e.shiftKey ? 15 : 3))
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [clock])

  if (!source) return <NeedData update={update} />
  const error = runA.error || runB.error
  const labelA = labelOf(s.a)
  const labelB = labelOf(s.b)
  const backlog = a?.result.backlog ?? []
  const panelRun = selected?.side === 'b' ? b : a
  const times = (r: SimResult) => r.orders.map(o => (o.deliveredAt >= 0 ? o.deliveredAt : r.horizon) - o.createdAt)

  return (
    <>
      {error && <div className="alert" role="alert">The simulator hit a problem: {error}</div>}
      {a && (
        <section className="verdict" aria-live="polite">
          <div className="verdict-text">
            {b ? <p>{verdict(a.metrics, b.metrics, labelB)}</p> : (
              <p><strong>{labelA}</strong>: {pct(a.metrics.stackShare)} of orders in stacks, {a.metrics.tempMean.toFixed(1)}&deg;C at the door, {money(a.metrics.payPerActiveHour)} per active hour. Switch on compare to see what it trades away.</p>
            )}
          </div>
          <div className="verdict-shapes">
            <figure><TradeoffTriangle efficiency={scoreEfficiency(a.metrics)} food={scoreFood(a.metrics)} pay={scorePay(a.metrics)} size={92} /><figcaption><span className="tag a">A</span></figcaption></figure>
            {b && <figure className="is-b"><TradeoffTriangle efficiency={scoreEfficiency(b.metrics)} food={scoreFood(b.metrics)} pay={scorePay(b.metrics)} size={92} /><figcaption><span className="tag b">B</span></figcaption></figure>}
            <p className="tri-key">Top: efficiency<br />Right: food<br />Left: courier pay</p>
          </div>
        </section>
      )}

      <div className="replay-grid">
        <div className="replay-maps">
          <div className={s.compare ? 'maps two' : 'maps'}>
            <CityMap result={a?.result ?? null} city={cityOf(source)} clock={clock} startHour={startHour}
              selected={selected?.side === 'a' ? selected.index : -1}
              onSelect={i => setSelected(i >= 0 ? { side: 'a', index: i } : null)}
              label={<><span className="tag a">A</span> {labelA}{runA.busy && <span className="spinner tiny" />}</>}
              ariaLabel={`Animated city map for ${labelA}. Click a courier to see their route and pay, or use the courier list.`} />
            {s.compare && (
              <CityMap result={b?.result ?? null} city={cityOf(source)} clock={clock} startHour={startHour}
                selected={selected?.side === 'b' ? selected.index : -1}
                onSelect={i => setSelected(i >= 0 ? { side: 'b', index: i } : null)}
                label={<><span className="tag b">B</span> {labelB}{runB.busy && <span className="spinner tiny" />}</>}
                ariaLabel={`Animated city map for ${labelB}. Click a courier to see their route and pay, or use the courier list.`} />
            )}
          </div>
          <Transport clock={clock} backlog={backlog} startHour={startHour} />
          <HeatLegend />
        </div>

        <aside className="replay-side">
          <StrategyCard tag="A" cls="is-a" spec={s.a} onChange={v => update({ a: v })} />
          <label className="switch">
            <input type="checkbox" checked={s.compare} onChange={e => update({ compare: e.target.checked })} />
            <span>Compare side by side</span>
          </label>
          {s.compare && <StrategyCard tag="B" cls="is-b" spec={s.b} onChange={v => update({ b: v })} />}
          <CourierPanel a={a?.result ?? null} b={b?.result ?? null} selected={selected} onSelect={setSelected} clock={clock} startHour={startHour} panel={panelRun?.result ?? null} />
          <details className="card world">
            <summary>World settings</summary>
            <div className="sliders">
              <Slider label="Courier speed" value={s.speedKmh} min={8} max={50} step={1} format={v => `${v} km/h`} onChange={speedKmh => update({ speedKmh })} />
              <Slider label="Road factor" value={s.roadFactor} min={1} max={2} step={0.05} format={v => `${v.toFixed(2)} x haversine`} onChange={roadFactor => update({ roadFactor })} />
              <Slider label="Largest stack" value={s.maxStack} min={1} max={4} step={1} format={v => `${v} orders`} onChange={maxStack => update({ maxStack })} />
            </div>
          </details>
        </aside>
      </div>

      {a && (
        <>
          <section className="section-head"><h2>Every number, side by side</h2><p>Undelivered orders stay in the figures as late and cold, so no strategy gets credit for abandoning its hardest orders.</p></section>
          <MetricsTable a={a.metrics} b={b?.metrics} labelA={labelA} labelB={labelB} />
          <section className="section-head"><h2>Where the differences live</h2></section>
          <div className="charts">
            <Histogram title="Delivery time" sub="Minutes from order to door. Dashed lines mark each strategy's p90." a={times(a.result)} b={b ? times(b.result) : undefined} labelA="A" labelB="B" unit="min" xLabel="Minutes"
              marks={[{ at: a.metrics.deliveryP90, text: 'A p90' }, ...(b ? [{ at: b.metrics.deliveryP90, text: 'B p90' }] : [])]} />
            <CoolingChart a={a.result.orders} b={b?.result.orders} labelA="A" labelB="B" />
            <Histogram title="The lowest-paid order inside each stack" sub="What the offer total hides. Each stack contributes its single worst-paid order." a={stacksOf(a.result).map(k => k.lowest)} b={b ? stacksOf(b.result).map(k => k.lowest) : undefined} labelA="A" labelB="B" unit="dollars" xLabel="Dollars" xMax={16} binsHint={16}
              marks={[{ at: a.result.cfg.lowPayLine, text: '$4 low-pay line' }]} />
            <LineChart title="Orders waiting for a courier" sub="Backlog over the shift. A rising line means the fleet has fallen behind." a={a.result.backlog} b={b?.result.backlog} labelA="A" labelB="B" xLabel="Time" yLabel="Orders" xf={v => clockLabel(v, startHour)} />
          </div>
          <p className="model-note">Pay model: base of {money(cfg.basePay)} plus {money(cfg.perMile)} per marginal route mile, floored at {money(cfg.minBase)}, plus tip. It is a stated assumption for this model. Uploaded payouts are used as given. Run took {Math.round(a.ms)} ms in a Web Worker.</p>
        </>
      )}
    </>
  )
}

function CourierPanel({ a, b, selected, onSelect, clock, startHour, panel }: {
  a: SimResult | null; b: SimResult | null; selected: { side: 'a' | 'b'; index: number } | null
  onSelect(v: { side: 'a' | 'b'; index: number } | null): void; clock: Clock; startHour?: number; panel: SimResult | null
}) {
  const [, force] = useState(0)
  const last = useRef(0)
  useEffect(() => clock.subscribe(() => {
    const now = performance.now()
    if (selected && now - last.current > 300) { last.current = now; force(n => n + 1) }
  }), [clock, selected])

  const options = (r: SimResult | null, side: 'a' | 'b') =>
    r?.couriers.map(c => <option key={`${side}${c.index}`} value={`${side}:${c.index}`}>{side.toUpperCase()}: {c.src.id}</option>)

  const picker = (
    <select aria-label="Choose a courier" value={selected ? `${selected.side}:${selected.index}` : ''} onChange={e => {
      if (!e.target.value) { onSelect(null); return }
      const [side, i] = e.target.value.split(':')
      onSelect({ side: side as 'a' | 'b', index: Number(i) })
    }}>
      <option value="">Choose a courier</option>
      {options(a, 'a')}
      {options(b, 'b')}
    </select>
  )
  if (!selected || !panel) {
    return (
      <section className="card courier-card">
        <h3>Courier</h3>
        <p className="muted small">Click any courier on the map to see their route, every order's pay, and the one hiding in the stack.</p>
        {picker}
      </section>
    )
  }
  const c = panel.couriers[selected.index]
  if (!c) return null
  const t = clock.t
  const mine = panel.orders.filter(o => o.courier === c.index && o.assignedAt <= t)
  // Only completed drops count, or rates spike the moment a big order is accepted.
  const earned = mine.filter(o => o.deliveredAt >= 0 && t >= o.deliveredAt).reduce((s, o) => s + o.pay, 0)
  const activeMin = activeUntil(c.legs, t)
  const miles = milesUntil(panel, c.index, t)
  const live = mine.filter(o => o.deliveredAt < 0 || t < o.deliveredAt)
  const lowest = live.length > 1 ? Math.min(...live.map(o => o.pay)) : -1
  const status = live.length === 0 ? 'Idle, waiting for an offer' : live.length > 1 ? `Running a stack of ${live.length}` : 'On a single order'
  const recent = mine.filter(o => o.deliveredAt >= 0 && t >= o.deliveredAt).slice(-3)
  const row = (o: OrderState, isLive: boolean) => {
    const temp = tempAt(o, o.deliveredAt >= 0 ? Math.min(t, o.deliveredAt) : t)
    return (
      <li key={o.index} className={isLive && o.pay === lowest ? 'order-row hidden-low' : 'order-row'}>
        <span className="order-id">{o.src.id}</span>
        <span className="order-state">{!isLive ? 'Delivered' : o.pickedAt >= 0 && t >= o.pickedAt ? 'In the bag' : 'Heading to store'} &middot; {temp.toFixed(0)}&deg;C</span>
        <span className="order-pay">{money(o.pay)}<small>{money(o.basePaid)} + {money(o.tip)} tip</small></span>
        {isLive && o.pay === lowest && <span className="low-flag">Lowest paid in this stack</span>}
      </li>
    )
  }
  return (
    <section className="card courier-card" aria-live="polite">
      <div className="courier-head">
        <h3><span className={`tag ${selected.side}`}>{selected.side.toUpperCase()}</span> {c.src.id}</h3>
        <button type="button" className="icon-btn small" aria-label="Close courier" onClick={() => onSelect(null)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <p className="courier-status">{status}</p>
      <dl className="courier-stats">
        <div><dt>Earned, delivered</dt><dd>{money(earned)}</dd></div>
        <div><dt>Per active hour</dt><dd>{activeMin > 1 ? money(earned / (activeMin / 60)) : 'n/a'}</dd></div>
        <div><dt>Per mile</dt><dd>{miles > 0.1 ? money(earned / miles) : 'n/a'}</dd></div>
      </dl>
      {live.length > 0 && <ul className="order-list">{live.map(o => row(o, true))}</ul>}
      {recent.length > 0 && <><h4 className="muted small">Recent drops, by {clockLabel(t, startHour)}</h4><ul className="order-list">{recent.map(o => row(o, false))}</ul></>}
      {picker}
    </section>
  )
}

function activeUntil(legs: SimResult['couriers'][number]['legs'], t: number): number {
  let total = 0
  for (const l of legs) {
    if (l.t0 >= t) break
    total += Math.min(t, l.t1) - l.t0
  }
  return total
}

function milesUntil(r: SimResult, c: number, t: number): number {
  const courier = r.couriers[c]
  const done = activeUntil(courier.legs.filter(l => l.kind === 'drive'), t)
  const all = activeUntil(courier.legs.filter(l => l.kind === 'drive'), Infinity)
  return all > 0 ? courier.miles * (done / all) : 0
}

const daysText = (d: number) => (!Number.isFinite(d) ? 'Never' : d > 365 ? 'Over a year' : `${d} ${d === 1 ? 'day' : 'days'}`)

function ExperimentView({ s, update, source, sourceKey, cfgKey }: { s: Settings; update(p: Partial<Settings>): void; source: Source; sourceKey: string; cfgKey: string }) {
  const [result, setResult] = useState<ExperimentOutput | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [metric, setMetric] = useState<OutcomeId>('deliveryMin')
  const [effectPct, setEffectPct] = useState(2)
  const cancel = useRef<(() => void) | null>(null)

  const run = () => {
    cancel.current?.()
    setError('')
    setProgress(0)
    const task = startTask<ExperimentOutput>({ kind: 'experiment', source, a: s.a, b: s.b, cfg: configOf(s), days: s.days, regions: s.regions, windowMin: s.windowMin }, setProgress)
    cancel.current = task.cancel
    task.promise.then(r => { setResult(r); setProgress(null) }).catch((e: Error) => { setError(e.message); setProgress(null) })
  }
  const key = `${sourceKey}/${cfgKey}/${JSON.stringify([s.a, s.b, s.days, s.regions, s.windowMin])}`
  const ranKey = useRef('')
  useEffect(() => {
    // The first visit runs by itself; afterwards a settings change marks results stale instead.
    if (!ranKey.current) { ranKey.current = key; run() }
    return () => cancel.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const stale = ranKey.current !== key

  const o = result?.outcomes[metric]
  const meta = OUTCOMES[metric]
  const target = o ? Math.max(Math.abs(o.control) * (effectPct / 100), 1e-6) : 0
  const f = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)} ${meta.unit}`
  const signFlip = o && Math.abs(o.truth) > 1e-6 && Math.sign(o.naive.diff) !== Math.sign(o.truth) && (o.naive.lo > 0 || o.naive.hi < 0)
  const missesTruth = o && (o.naive.lo > o.truth || o.naive.hi < o.truth)
  const sbCovers = o && o.switchback.lo <= o.truth && o.switchback.hi >= o.truth
  const biasShare = o && Math.abs(o.truth) > 1e-6 ? Math.abs(o.naiveBias / o.truth) : 0

  return (
    <>
      <section className="section-head first">
        <h2>Switchback against a naive A/B</h2>
        <p>In a naive order-level test both arms share one courier fleet, and orders in the stacking arm have half as many partners to stack with, so it measures a world that will never ship. A switchback randomizes whole time-region units instead. Because this is a simulator, it can also run each strategy alone on the same days and reveal the truth a live marketplace never sees.</p>
      </section>
      <div className="experiment-config card">
        <div className="exp-arms">
          <label><span className="tag a">A</span> Control
            <select value={s.a.id} onChange={e => update({ a: { ...s.a, id: e.target.value as StrategyId } })}>
              {(Object.keys(STRATEGY_LABEL) as StrategyId[]).map(id => <option key={id} value={id}>{STRATEGY_LABEL[id]}</option>)}
            </select>
          </label>
          {s.a.id === 'optimizer' && <Slider label="A batching" value={s.a.batch} format={pct} onChange={batch => update({ a: { ...s.a, batch } })} />}
          <label><span className="tag b">B</span> Treatment
            <select value={s.b.id} onChange={e => update({ b: { ...s.b, id: e.target.value as StrategyId } })}>
              {(Object.keys(STRATEGY_LABEL) as StrategyId[]).map(id => <option key={id} value={id}>{STRATEGY_LABEL[id]}</option>)}
            </select>
          </label>
          {s.b.id === 'optimizer' && <Slider label="B batching" value={s.b.batch} format={pct} onChange={batch => update({ b: { ...s.b, batch } })} />}
        </div>
        <div className="exp-design">
          <Slider label="Days" value={s.days} min={2} max={30} step={1} format={v => `${v} days`} onChange={days => update({ days })} />
          <label>Regions
            <select value={s.regions} onChange={e => update({ regions: Number(e.target.value) })}>
              <option value={1}>1, whole city</option><option value={2}>4 regions</option><option value={3}>9 regions</option><option value={4}>16 regions</option>
            </select>
          </label>
          <label>Switchback window
            <select value={s.windowMin} onChange={e => update({ windowMin: Number(e.target.value) })}>
              {[15, 30, 60, 120].map(v => <option key={v} value={v}>{v} minutes</option>)}
            </select>
          </label>
          <button type="button" className={stale ? 'btn btn-red pulse' : 'btn btn-red'} disabled={progress !== null} onClick={() => { ranKey.current = key; run() }}>
            {progress !== null ? `Running ${Math.round(progress * 100)}%` : stale ? 'Run with new settings' : 'Run again'}
          </button>
        </div>
        {progress !== null && <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Experiment progress"><i style={{ width: `${progress * 100}%` }} /></div>}
      </div>
      {error && <div className="alert" role="alert">The experiment failed: {error}</div>}
      {!result && !error && <div className="empty"><span className="spinner" /><p>Simulating {s.days * 4} marketplace days in a Web Worker.</p></div>}
      {result && o && (
        <div className={stale ? 'is-stale' : undefined}>
          <div className="pills outcome-pills" role="group" aria-label="Outcome">
            {(Object.keys(OUTCOMES) as OutcomeId[]).map(k => (
              <button key={k} type="button" className={metric === k ? 'pill on' : 'pill'} aria-pressed={metric === k} onClick={() => setMetric(k)}>{OUTCOMES[k].label}</button>
            ))}
          </div>
          <section className="exp-hero card">
            <div className="exp-claim">
              <span className="eyebrow">Interference bias, {meta.label.toLowerCase()}</span>
              <p className="exp-big">{signFlip ? 'Naive A/B gets the sign wrong.' : missesTruth ? `Naive A/B misses the truth by ${Math.round(biasShare * 100)}%.` : 'Naive A/B lands near the truth here.'}</p>
              <p>The effect of running B everywhere is <b>{f(o.truth)}</b>. The naive test reports <b>{f(o.naive.diff)}</b> with an interval{missesTruth ? ' that excludes the truth' : ' that includes it'}. The switchback reports <b>{f(o.switchback.diff)}</b>, and its wider interval {sbCovers ? 'covers the truth' : 'still misses it, most likely because couriers and stack partners carry across units. Try a longer window'}.</p>
            </div>
            <div className="exp-plot" data-tip-root>
              <EstimateChart o={o} unit={meta.unit} />
            </div>
          </section>

          <div className="stat-row">
            <div className="stat"><span>Switchback power, {result.days} days</span><b>{pct(powerAt(target, o.switchback.se))}</b><small>to detect {target.toFixed(2)} {meta.unit}</small></div>
            <div className="stat accent"><span>Run needed for 80% power</span><b>{daysText(daysForPower(target, o.switchback.se, result.days))}</b><small>{result.windows * result.regions} units a day, clustered by region and day</small></div>
            <div className="stat"><span>What naive A/B would promise</span><b>{daysText(daysForPower(target, o.naive.se, result.days))}</b><small>False comfort: its error bar ignores interference</small></div>
            <div className="stat"><span>Units analysed</span><b>{result.units}</b><small>{result.ordersPerDay} orders a day on average</small></div>
          </div>

          <div className="card effect-slider">
            <Slider label="Smallest effect worth detecting" value={effectPct} min={0.5} max={15} step={0.5} format={v => `${v}% of control (${(Math.abs(o.control) * v / 100).toFixed(2)} ${meta.unit})`} onChange={setEffectPct} />
          </div>

          <div className="charts">
            <PowerChart effect={target} seSwitchback={o.switchback.se} seNaive={o.naive.se} days={result.days} unit={meta.unit} />
            <SwitchbackGrid grid={result.grid} regions={result.regions} windows={result.windows} windowMin={result.windowMin} labelA={labelOf(s.a)} labelB={labelOf(s.b)} />
          </div>

          <section className="section-head"><h2>All outcomes</h2></section>
          <div className="table-wrap">
            <table className="metrics">
              <thead><tr><th scope="col">Outcome, B minus A</th><th scope="col" className="num">Truth</th><th scope="col" className="num">Switchback (95% CI)</th><th scope="col" className="num">Naive A/B (95% CI)</th><th scope="col" className="num">Naive bias</th><th scope="col" className="num">Switchback bias</th></tr></thead>
              <tbody>
                {(Object.keys(OUTCOMES) as OutcomeId[]).map(k => {
                  const r = result.outcomes[k]
                  const v = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(2)}`
                  return (
                    <tr key={k}>
                      <th scope="row">{OUTCOMES[k].label} ({OUTCOMES[k].unit})</th>
                      <td className="num strong">{v(r.truth)}</td>
                      <td className="num">{v(r.switchback.diff)} <small>[{v(r.switchback.lo)}, {v(r.switchback.hi)}]</small></td>
                      <td className="num">{v(r.naive.diff)} <small>[{v(r.naive.lo)}, {v(r.naive.hi)}]</small></td>
                      <td className="num">{v(r.naiveBias)}</td>
                      <td className="num">{v(r.switchbackBias)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="model-note">Unit outcomes are simple averages of time-region units. The variance is a CR1 sandwich clustered by region and day, with a t critical value on clusters minus one degrees of freedom. An order keeps the variant of the unit it was created in. The power readout scales the standard error by the root of the run length, which assumes later days look like these.</p>
        </div>
      )}
    </>
  )
}

function SweepView({ s, update, source, sourceKey, cfgKey }: { s: Settings; update(p: Partial<Settings>): void; source: Source; sourceKey: string; cfgKey: string }) {
  const [points, setPoints] = useState<SweepOutput | null>(null)
  const [progress, setProgress] = useState<number | null>(0)
  const [error, setError] = useState('')
  const [days, setDays] = useState(3)
  const fixedKey = `${sourceKey}/${cfgKey}/${s.a.fresh}/${s.a.pay}/${days}`
  useEffect(() => {
    setProgress(0)
    setError('')
    const task = startTask<SweepOutput>({ kind: 'sweep', source, spec: { ...s.a, id: 'optimizer' }, cfg: configOf(s), steps: 11, days }, setProgress)
    task.promise.then(r => { setPoints(r); setProgress(null) }).catch((e: Error) => { setError(e.message); setProgress(null) })
    return task.cancel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedKey])
  const sel = points?.reduce((best, p) => (Math.abs(p.batch - s.a.batch) < Math.abs(best.batch - s.a.batch) ? p : best))
  return (
    <>
      <section className="section-head first">
        <h2>The batching frontier</h2>
        <p>Each point runs the optimizer at one batching weight, averaged across days. A filled point is on the Pareto frontier: nothing else beats it on efficiency, food and courier pay at once. Click a point to apply it to strategy A.</p>
      </section>
      <div className="sweep-layout">
        <section className="card sweep-card">
          {progress !== null && <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Sweep progress"><i style={{ width: `${progress * 100}%` }} /></div>}
          {error && <div className="alert" role="alert">The sweep failed: {error}</div>}
          {!points && !error && <div className="empty"><span className="spinner" /><p>Running 11 settings across {days} days.</p></div>}
          {points && <SweepChart points={points} selected={s.a.id === 'optimizer' ? s.a.batch : undefined} onPick={batch => update({ a: { ...s.a, id: 'optimizer', batch } })} />}
        </section>
        <aside className="sweep-side">
          {sel && (
            <section className="card applied">
              <span className="eyebrow">{Math.abs(sel.batch - s.a.batch) < 0.005 ? 'Applied to A' : `Nearest point to A, which is at ${Math.round(s.a.batch * 100)}`}</span>
              <p className="applied-big">Batching {Math.round(sel.batch * 100)}</p>
              <dl className="courier-stats">
                <div><dt>In stacks</dt><dd>{pct(sel.metrics.stackShare)}</dd></div>
                <div><dt>Courier min</dt><dd>{sel.metrics.courierMinPerDelivery.toFixed(1)}</dd></div>
                <div><dt>At the door</dt><dd>{sel.metrics.tempMean.toFixed(1)}&deg;C</dd></div>
                <div><dt>Per active hr</dt><dd>{money(sel.metrics.payPerActiveHour)}</dd></div>
                <div><dt>Per online hr</dt><dd>{money(sel.metrics.payPerOnlineHour)}</dd></div>
                <div><dt>Low-pay stacks</dt><dd>{pct(sel.metrics.hiddenLowPayRate)}</dd></div>
              </dl>
              <button type="button" className="btn btn-red wide" onClick={() => update({ tab: 'replay' })}>Watch it replay</button>
            </section>
          )}
          <section className="card">
            <div className="sliders">
              <Slider label="Days per point" value={days} min={1} max={8} step={1} format={v => `${v}`} onChange={setDays} />
              <Slider label="Food quality weight" value={s.a.fresh} format={pct} onChange={fresh => update({ a: { ...s.a, fresh } })} />
              <Slider label="Courier pay floor weight" value={s.a.pay} format={pct} onChange={pay => update({ a: { ...s.a, pay } })} />
            </div>
          </section>
        </aside>
      </div>
      {points && (
        <details className="card table-details">
          <summary>View as a table</summary>
          <div className="table-wrap">
            <table className="metrics">
              <thead><tr><th scope="col">Batching</th><th scope="col" className="num">In stacks</th><th scope="col" className="num">Courier min per delivery</th><th scope="col" className="num">At the door</th><th scope="col" className="num">P90 min</th><th scope="col" className="num">Per active hr</th><th scope="col" className="num">Cost per delivery</th><th scope="col" className="num">Frontier</th></tr></thead>
              <tbody>{points.map(p => (
                <tr key={p.batch}><th scope="row">{Math.round(p.batch * 100)}</th><td className="num">{pct(p.metrics.stackShare)}</td><td className="num">{p.metrics.courierMinPerDelivery.toFixed(1)}</td><td className="num">{p.metrics.tempMean.toFixed(1)}&deg;C</td><td className="num">{p.metrics.deliveryP90.toFixed(1)}</td><td className="num">{money(p.metrics.payPerActiveHour)}</td><td className="num">{money(p.metrics.platformCost)}</td><td className="num">{p.onFrontier ? 'Yes' : 'No'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
    </>
  )
}

function SweepChart(props: { points: SweepOutput; selected?: number; onPick(batch: number): void }) {
  const box = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  return (
    <div className="chart bare" ref={box} onMouseMove={e => {
      const text = (e.target as Element).closest('[data-tip]')?.getAttribute('data-tip')
      const b = box.current?.getBoundingClientRect()
      setTip(text && b ? { x: Math.min(e.clientX - b.left + 12, b.width - 200), y: Math.max(0, e.clientY - b.top - 60), text } : null)
    }} onMouseLeave={() => setTip(null)}>
      <FrontierChart {...props} />
      {tip && <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  )
}

function FileDrop({ label, value, onChange, placeholder }: { label: string; value: string; onChange(v: string): void; placeholder: string }) {
  const [over, setOver] = useState(false)
  const [note, setNote] = useState('')
  const read = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 12_000_000) { setNote(`${file.name} is over 12 MB. Trim it first.`); return }
    onChange(await file.text())
    setNote(`Loaded ${file.name}`)
  }
  return (
    <div className={over ? 'drop over' : 'drop'}
      onDragOver={(e: DragEvent) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files[0]) }}>
      <label className="drop-head">
        <span>{label}</span>
        <span className="btn btn-quiet btn-small file-btn">Choose file
          <input type="file" accept=".csv,.json,text/csv,application/json" onChange={(e: ChangeEvent<HTMLInputElement>) => void read(e.target.files?.[0])} />
        </span>
      </label>
      <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} aria-label={`${label}, paste CSV or JSON`} rows={9} />
      {note && <span className="muted small">{note}</span>}
    </div>
  )
}

function DataView({ dataset, onLoad }: { dataset: Dataset | null; onLoad(d: Dataset | null): void }) {
  const [orders, setOrders] = useState('')
  const [couriers, setCouriers] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const submit = () => {
    const p = parseDataset(orders, couriers)
    setErrors(p.errors)
    setWarnings(p.warnings)
    if (p.dataset && !p.errors.length) onLoad(p.dataset)
  }
  const span = dataset ? quantile(dataset.orders.map(o => o.createdAt), 1) : 0
  return (
    <>
      <section className="section-head first">
        <h2>Replay your own marketplace</h2>
        <p>Paste or upload orders and couriers as CSV or JSON. Everything runs and stays in this browser. Nothing is uploaded anywhere.</p>
      </section>
      {dataset && (
        <section className="card loaded">
          <div><span className="eyebrow">Loaded</span><p className="applied-big">{dataset.orders.length} orders, {dataset.couriers.length} couriers</p><p className="muted small">Spanning {Math.round(span)} minutes.</p></div>
          <button type="button" className="btn btn-quiet" onClick={() => onLoad(null)}>Remove</button>
        </section>
      )}
      <div className="data-grid">
        <FileDrop label="Orders" value={orders} onChange={setOrders} placeholder={'order_id,created_min,store_lat,store_lng,customer_lat,customer_lng,prep_min,payout\nO1,4.5,39.51,-98.33,39.49,-98.36,12,8.25'} />
        <FileDrop label="Couriers (optional)" value={couriers} onChange={setCouriers} placeholder={'courier_id,shift_start,shift_end,start_lat,start_lng\nC1,0,180,39.50,-98.35'} />
      </div>
      <div className="data-actions">
        <button type="button" className="btn btn-red" disabled={!orders.trim()} onClick={submit}>Load and replay</button>
        <button type="button" className="btn btn-quiet" onClick={() => { const x = sampleCsv(); setOrders(x.orders); setCouriers(x.couriers); setErrors([]); setWarnings([]) }}>Fill with a synthetic sample</button>
      </div>
      {errors.length > 0 && <div className="alert" role="alert"><strong>Fix these and load again.</strong><ul>{errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
      {warnings.length > 0 && <div className="note" role="status"><ul>{warnings.map(w => <li key={w}>{w}</li>)}</ul></div>}
      <section className="card format">
        <h3>Format</h3>
        <div className="format-grid">
          <div><h4>Orders</h4><p className="muted small">Created time, store lat and lng, customer lat and lng, prep minutes, and optionally payout. Times can be minutes, HH:MM or ISO timestamps. With a payout, it is used as the courier's pay and the pay model is skipped.</p></div>
          <div><h4>Couriers</h4><p className="muted small">Shift start, shift end, start lat and lng. Leave this blank and a clearly labelled assumed fleet is added.</p></div>
          <div><h4>JSON</h4><p className="muted small">An array, or one object with <code>orders</code> and <code>couriers</code> arrays, pasted in the orders box.</p></div>
        </div>
      </section>
    </>
  )
}
