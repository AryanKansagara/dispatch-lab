import { useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { TEMP, tempAt } from './engine/metrics.ts'
import type { OutcomeResult } from './engine/experiment.ts'
import { powerAt, type GridCell } from './engine/experiment.ts'
import type { SweepPoint } from './engine/sweep.ts'
import type { OrderState } from './engine/types.ts'

/** Frame with a delegated tooltip: any mark carrying data-tip shows it on hover or focus. */
export function ChartFrame({ title, sub, legend, children, foot }: { title: string; sub?: string; legend?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const show = (el: Element, x: number, y: number) => {
    const text = el.closest('[data-tip]')?.getAttribute('data-tip')
    const b = box.current?.getBoundingClientRect()
    if (!text || !b) { setTip(null); return }
    setTip({ x: Math.min(x - b.left + 12, b.width - 190), y: Math.max(0, y - b.top - 40), text })
  }
  return (
    <figure className="chart" ref={box}
      onMouseMove={(e: MouseEvent) => show(e.target as Element, e.clientX, e.clientY)}
      onMouseLeave={() => setTip(null)}
      onFocus={e => {
        const r = e.target.getBoundingClientRect()
        show(e.target, r.left + r.width / 2, r.top)
      }}
      onBlur={() => setTip(null)}
    >
      <figcaption>
        <h3>{title}</h3>
        {sub && <p>{sub}</p>}
        {legend && <div className="chart-legend">{legend}</div>}
      </figcaption>
      {children}
      {foot && <div className="chart-foot">{foot}</div>}
      {tip && <div className="tip" role="status" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </figure>
  )
}

export const Key = ({ color, label, dash }: { color: string; label: string; dash?: boolean }) => (
  <span className="key"><i style={dash ? { background: 'none', borderTop: `2px dashed ${color}`, height: 0 } : { background: color }} />{label}</span>
)

function ticks(lo: number, hi: number, n = 4): number[] {
  const span = hi - lo || 1
  const raw = span / n
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? mag * 10
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)))
  return out
}

interface Plot { w: number; h: number; l: number; r: number; t: number; b: number }
const PLOT: Plot = { w: 560, h: 250, l: 44, r: 14, t: 24, b: 36 }

function Grid({ p, xTicks, yTicks, x, y, xf = String, yf = String, xLabel, yLabel }: {
  p: Plot; xTicks: number[]; yTicks: number[]; x(v: number): number; y(v: number): number
  xf?(v: number): string; yf?(v: number): string; xLabel: string; yLabel?: string
}) {
  return (
    <g className="axes">
      {yTicks.map(v => (
        <g key={v}>
          <line x1={p.l} x2={p.w - p.r} y1={y(v)} y2={y(v)} className="gridline" />
          <text x={p.l - 8} y={y(v) + 4} textAnchor="end">{yf(v)}</text>
        </g>
      ))}
      {xTicks.map(v => <text key={v} x={x(v)} y={p.h - p.b + 16} textAnchor="middle">{xf(v)}</text>)}
      <text x={(p.l + p.w - p.r) / 2} y={p.h - 4} textAnchor="middle" className="axis-title">{xLabel}</text>
      {yLabel && <text x={p.l} y={p.t - 12} className="axis-title" textAnchor="start">{yLabel}</text>}
    </g>
  )
}

/** Up to two series as adjacent thin bars with rounded tops, plus optional reference lines. */
export function Histogram({ a, b, labelA, labelB, unit, xLabel, marks = [], binsHint = 22, title, sub, xMax }: {
  a: number[]; b?: number[]; labelA: string; labelB?: string; unit: string; xLabel: string
  marks?: { at: number; text: string; color?: string }[]; binsHint?: number; title: string; sub?: string; xMax?: number
}) {
  const all = [...a, ...(b ?? [])]
  if (!all.length) return <ChartFrame title={title} sub={sub}><p className="chart-empty">No data for this run.</p></ChartFrame>
  const sorted = [...all].sort((p, q) => p - q)
  const lo = Math.floor(sorted[0])
  const hi = Math.ceil(xMax ?? sorted[Math.floor(sorted.length * 0.995)] ?? sorted[sorted.length - 1])
  const width = Math.max(0.5, (hi - lo) / binsHint)
  const n = Math.max(1, Math.ceil((hi - lo) / width))
  const bin = (v: number[]) => {
    const c = new Array<number>(n).fill(0)
    for (const x of v) c[Math.min(n - 1, Math.max(0, Math.floor((x - lo) / width)))]++
    return c
  }
  const ca = bin(a).map(c => c / Math.max(1, a.length))
  const cb = b ? bin(b).map(c => c / Math.max(1, b.length)) : null
  const top = Math.max(...ca, ...(cb ?? [0]), 0.01)
  const p = PLOT
  const x = (v: number) => p.l + ((v - lo) / (hi - lo || 1)) * (p.w - p.l - p.r)
  const y = (v: number) => p.h - p.b - (v / top) * (p.h - p.t - p.b)
  const slot = (p.w - p.l - p.r) / n
  const barW = Math.max(1.5, cb ? slot / 2 - 1 : slot - 2)
  const bar = (v: number, i: number, off: number, color: string, label: string) => {
    if (v <= 0) return null
    const bx = p.l + i * slot + off
    const h = p.h - p.b - y(v)
    const r = Math.min(barW / 2, 3, h)
    return <path key={`${label}${i}`} fill={color}
      d={`M${bx},${p.h - p.b}v${-(h - r)}q0,${-r} ${r},${-r}h${barW - 2 * r}q${r},0 ${r},${r}v${h - r}z`} />
  }
  return (
    <ChartFrame title={title} sub={sub} legend={b && labelB ? <><Key color="var(--a)" label={labelA} /><Key color="var(--b)" label={labelB} /></> : undefined}>
      <svg viewBox={`0 0 ${p.w} ${p.h}`} role="img" aria-label={`${title}. ${sub ?? ''}`}>
        <Grid p={p} xTicks={ticks(lo, hi, 6)} yTicks={ticks(0, top * 100, 3).map(v => v / 100)} x={x} y={y} xLabel={xLabel} yf={v => `${Math.round(v * 100)}%`} yLabel="Share of orders" />
        {ca.map((v, i) => bar(v, i, cb ? 0.5 : 1, 'var(--a)', 'a'))}
        {cb?.map((v, i) => bar(v, i, slot / 2 + 0.5, 'var(--b)', 'b'))}
        {ca.map((v, i) => (
          <rect key={i} x={p.l + i * slot} y={p.t} width={slot} height={p.h - p.t - p.b} fill="transparent"
            data-tip={`${(lo + i * width).toFixed(1)} to ${(lo + (i + 1) * width).toFixed(1)} ${unit}: ${labelA} ${(v * 100).toFixed(1)}%${cb ? `, ${labelB} ${(cb[i] * 100).toFixed(1)}%` : ''}`} />
        ))}
        {marks.map((m, i) => (
          <g key={i} pointerEvents="none">
            <line x1={x(m.at)} x2={x(m.at)} y1={p.t + 8} y2={p.h - p.b} stroke={m.color ?? 'var(--ink)'} strokeWidth="2" strokeDasharray="3 4" strokeLinecap="round" />
            <text x={x(m.at) + 5} y={p.t + 14 + (i % 2) * 14} className="mark-label">{m.text}</text>
          </g>
        ))}
      </svg>
    </ChartFrame>
  )
}

/** The cooling model as two curves with each delivered order plotted on it. */
export function CoolingChart({ a, b, labelA, labelB }: { a: OrderState[]; b?: OrderState[]; labelA: string; labelB?: string }) {
  const p = PLOT
  const maxX = 50
  const x = (v: number) => p.l + (Math.min(v, maxX) / maxX) * (p.w - p.l - p.r)
  const lo = 30
  const hi = TEMP.hotC + 2
  const y = (v: number) => p.h - p.b - ((v - lo) / (hi - lo)) * (p.h - p.t - p.b)
  const curve = (temp: (m: number) => number) => Array.from({ length: 51 }, (_, m) => `${m ? 'L' : 'M'}${x(m).toFixed(1)},${y(temp(m)).toFixed(1)}`).join('')
  const sample = (list: OrderState[]) => list.filter(o => o.deliveredAt >= 0).filter((_, i, s) => i % Math.max(1, Math.floor(s.length / 130)) === 0)
  const dot = (o: OrderState, color: string, name: string) => {
    const since = o.deliveredAt - o.readyAt
    const t = tempAt(o, o.deliveredAt)
    return <circle key={name + o.index} cx={x(since)} cy={y(t)} r="3.6" fill={color} stroke="var(--surface)" strokeWidth="1.5"
      data-tip={`${name} ${o.src.id}: ${t.toFixed(1)}°C at the door, ${since.toFixed(0)} min after ready, ${Math.max(0, o.pickedAt - o.readyAt).toFixed(0)} min on the shelf`} />
  }
  return (
    <ChartFrame title="Cooling curve, with every sampled order on it" sub="Food cools fastest on the shelf. A dot low and right of the bag curve sat waiting for its courier."
      legend={<>{b && labelB ? <><Key color="var(--a)" label={labelA} /><Key color="var(--b)" label={labelB} /></> : <Key color="var(--a)" label={labelA} />}<Key color="var(--muted)" label="Model limits" dash /></>}>
      <svg viewBox={`0 0 ${p.w} ${p.h}`} role="img" aria-label="Food temperature against minutes since the order was ready, with delivered orders plotted.">
        <rect x={p.l} y={y(TEMP.coldBelowC)} width={p.w - p.l - p.r} height={p.h - p.b - y(TEMP.coldBelowC)} fill="var(--cold-zone)" />
        <Grid p={p} xTicks={[0, 10, 20, 30, 40, 50]} yTicks={[30, 40, 50, 60, 70]} x={x} y={y} xLabel="Minutes since the food was ready" yLabel="°C at the door" />
        <path d={curve(m => tempAt({ readyAt: 0, pickedAt: 0 }, m))} className="curve" />
        <path d={curve(m => tempAt({ readyAt: 0, pickedAt: -1 }, m))} className="curve" />
        <text x={x(46)} y={y(tempAt({ readyAt: 0, pickedAt: 0 }, 46)) - 8} textAnchor="end" className="mark-label">in the bag from the start</text>
        <text x={x(28)} y={y(tempAt({ readyAt: 0, pickedAt: -1 }, 28)) + 16} textAnchor="end" className="mark-label">left on the shelf</text>
        <text x={p.w - p.r - 4} y={y(TEMP.coldBelowC) + 14} textAnchor="end" className="mark-label">cold line, {TEMP.coldBelowC}&deg;C</text>
        {sample(a).map(o => dot(o, 'var(--a)', labelA))}
        {b && sample(b).map(o => dot(o, 'var(--b)', labelB ?? 'B'))}
      </svg>
    </ChartFrame>
  )
}

export function LineChart({ title, sub, a, b, labelA, labelB, xLabel, yLabel, xf }: {
  title: string; sub?: string; a: number[]; b?: number[]; labelA: string; labelB?: string; xLabel: string; yLabel: string; xf?(v: number): string
}) {
  const p = PLOT
  const len = Math.max(a.length, b?.length ?? 0, 2)
  const top = Math.max(...a.map(v => v ?? 0), ...(b ?? []).map(v => v ?? 0), 1)
  const x = (v: number) => p.l + (v / (len - 1)) * (p.w - p.l - p.r)
  const y = (v: number) => p.h - p.b - (v / top) * (p.h - p.t - p.b)
  const path = (v: number[]) => v.map((q, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(q ?? 0).toFixed(1)}`).join('')
  const [hover, setHover] = useState<number | null>(null)
  return (
    <ChartFrame title={title} sub={sub} legend={b && labelB ? <><Key color="var(--a)" label={labelA} /><Key color="var(--b)" label={labelB} /></> : undefined}>
      <svg viewBox={`0 0 ${p.w} ${p.h}`} role="img" aria-label={`${title}. ${sub ?? ''}`}
        onMouseMove={e => {
          const box = e.currentTarget.getBoundingClientRect()
          const u = ((e.clientX - box.left) / box.width) * p.w
          setHover(Math.max(0, Math.min(len - 1, Math.round(((u - p.l) / (p.w - p.l - p.r)) * (len - 1)))))
        }}
        onMouseLeave={() => setHover(null)}>
        <Grid p={p} xTicks={ticks(0, len - 1, 6)} yTicks={ticks(0, top, 3)} x={x} y={y} xLabel={xLabel} yLabel={yLabel} xf={xf} />
        <path d={path(a)} className="series" stroke="var(--a)" />
        {b && <path d={path(b)} className="series" stroke="var(--b)" />}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={p.t} y2={p.h - p.b} className="crosshair" />
            <circle cx={x(hover)} cy={y(a[hover] ?? 0)} r="4.5" fill="var(--a)" stroke="var(--surface)" strokeWidth="2" />
            {b && <circle cx={x(hover)} cy={y(b[hover] ?? 0)} r="4.5" fill="var(--b)" stroke="var(--surface)" strokeWidth="2" />}
            <rect x={p.l} y={p.t} width={p.w - p.l - p.r} height={p.h - p.t - p.b} fill="transparent"
              data-tip={`${xf ? xf(hover) : hover}: ${labelA} ${a[hover] ?? 0}${b ? `, ${labelB} ${b[hover] ?? 0}` : ''}`} />
          </g>
        )}
      </svg>
    </ChartFrame>
  )
}

const money = (v: number) => `$${v.toFixed(2)}`

/** The frontier: x is courier minutes per delivery, y is food at the door, colour is courier pay. */
export function FrontierChart({ points, selected, onPick, compact }: { points: SweepPoint[]; selected?: number; onPick?(batch: number): void; compact?: boolean }) {
  const p: Plot = compact ? { ...PLOT, h: 310, b: 40, t: 30 } : { w: 960, h: 440, l: 44, r: 20, t: 34, b: 42 }
  const xs = points.map(q => q.metrics.courierMinPerDelivery)
  const ys = points.map(q => q.metrics.tempMean)
  const pays = points.map(q => q.metrics.payPerActiveHour)
  const pad = (v: number[], f = 0.14) => {
    const a = Math.min(...v)
    const b = Math.max(...v)
    const d = (b - a || 1) * f
    return [a - d, b + d]
  }
  const [xLo, xHi] = pad(xs)
  const [yLo, yHi] = pad(ys, 0.18)
  const payLo = Math.min(...pays)
  const payHi = Math.max(...pays)
  // Efficiency improves to the right, so less courier time plots further right.
  const x = (v: number) => p.l + ((xHi - v) / (xHi - xLo)) * (p.w - p.l - p.r)
  const y = (v: number) => p.h - p.b - ((v - yLo) / (yHi - yLo)) * (p.h - p.t - p.b)
  const shade = (v: number) => `color-mix(in oklab, var(--a) ${Math.round(30 + ((v - payLo) / (payHi - payLo || 1)) * 70)}%, var(--surface))`
  const front = points.filter(q => q.onFrontier).sort((a, b) => a.batch - b.batch)
  // Crowded points keep their dot but only label every one with room, so numbers never collide.
  const labelled = new Set<number>()
  let lastX = -Infinity
  let lastY = -Infinity
  for (const q of [...points].sort((a, b) => a.batch - b.batch)) {
    const px = x(q.metrics.courierMinPerDelivery)
    const py = y(q.metrics.tempMean)
    if (Math.hypot(px - lastX, py - lastY) >= 30) { labelled.add(q.batch); lastX = px; lastY = py }
  }
  return (
    <div className="frontier">
      <svg viewBox={`0 0 ${p.w} ${p.h}`} role="group" aria-label="Pareto frontier of the batching weight. Each point is one setting of the slider.">
        <Grid p={p} xTicks={ticks(xLo, xHi, 5).filter(v => v >= xLo && v <= xHi)} yTicks={ticks(yLo, yHi, 4)} x={x} y={y}
          xLabel="More efficient: fewer courier minutes per delivery →" yLabel="Hotter food, °C at the door ↑" xf={v => v.toFixed(1)} yf={v => v.toFixed(0)} />
        {front.length > 1 && <path className="series" stroke="var(--a)" d={front.map((q, i) => `${i ? 'L' : 'M'}${x(q.metrics.courierMinPerDelivery).toFixed(1)},${y(q.metrics.tempMean).toFixed(1)}`).join('')} />}
        {points.map(q => {
          const cx = x(q.metrics.courierMinPerDelivery)
          const cy = y(q.metrics.tempMean)
          const isSel = selected !== undefined && Math.abs(selected - q.batch) < 0.005
          const tip = `Batching ${Math.round(q.batch * 100)}: ${q.metrics.courierMinPerDelivery.toFixed(1)} courier min per delivery, ${q.metrics.tempMean.toFixed(1)}°C at the door, ${money(q.metrics.payPerActiveHour)} per active hour, ${Math.round(q.metrics.stackShare * 100)}% in stacks${q.onFrontier ? '' : '. Dominated'}`
          const body = (
            <>
              <circle cx={cx} cy={cy} r="15" fill="transparent" />
              {isSel && <circle cx={cx} cy={cy} r="12" fill="none" stroke="var(--ink)" strokeWidth="2" />}
              <circle cx={cx} cy={cy} r={q.onFrontier ? 7.5 : 5.5} fill={q.onFrontier ? shade(q.metrics.payPerActiveHour) : 'var(--surface)'} stroke={q.onFrontier ? 'var(--surface)' : 'var(--muted)'} strokeWidth="2" />
              {labelled.has(q.batch) && <text x={cx + 10} y={cy - 11} textAnchor="start" className="point-label">{Math.round(q.batch * 100)}</text>}
            </>
          )
          return onPick
            ? <a key={q.batch} role="button" tabIndex={0} className="frontier-point" data-tip={tip} aria-label={`Apply batching weight ${Math.round(q.batch * 100)}. ${tip}`}
                onClick={() => onPick(q.batch)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(q.batch) } }}>{body}</a>
            : <g key={q.batch} data-tip={tip}>{body}</g>
        })}
      </svg>
      <div className="frontier-key">
        <span className="key"><i className="round" style={{ background: 'var(--a)' }} />On the frontier, numbered by batching weight</span>
        {points.some(q => !q.onFrontier) && <span className="key"><i className="round hollow" />Dominated: another setting beats it on all three sides</span>}
        <span className="pay-scale"><span>{money(payLo)}</span><i /><span>{money(payHi)} per active hour</span></span>
      </div>
    </div>
  )
}

/** Three estimates of one effect on one axis, so the bias is visible as distance from the truth. */
export function EstimateChart({ o, unit, compact }: { o: OutcomeResult; unit: string; compact?: boolean }) {
  const rows = [
    { name: 'Truth', detail: 'All A against all B, same days', mid: o.truth, lo: o.truth, hi: o.truth, cls: 'est-truth' },
    { name: 'Switchback', detail: 'Cluster-robust 95% CI', mid: o.switchback.diff, lo: o.switchback.lo, hi: o.switchback.hi, cls: 'est-sb' },
    { name: 'Naive A/B', detail: 'Order-level 95% CI', mid: o.naive.diff, lo: o.naive.lo, hi: o.naive.hi, cls: 'est-naive' },
  ]
  const lo = Math.min(0, ...rows.map(r => r.lo))
  const hi = Math.max(0, ...rows.map(r => r.hi))
  const d = (hi - lo || 1) * 0.1
  const W = 620
  const L = compact ? 110 : 170
  const R = 22
  const rowH = 52
  const H = rowH * 3 + 40
  const x = (v: number) => L + ((v - (lo - d)) / (hi - lo + 2 * d)) * (W - L - R)
  const f = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`
  return (
    <svg className="estimates" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`True effect ${f(o.truth)} ${unit}. Switchback estimate ${f(o.switchback.diff)}. Naive A/B estimate ${f(o.naive.diff)}.`}>
      {ticks(lo - d, hi + d, 5).map(v => (
        <g key={v} className="axes">
          <line x1={x(v)} x2={x(v)} y1={8} y2={H - 28} className="gridline" />
          <text x={x(v)} y={H - 10} textAnchor="middle">{f(v)}</text>
        </g>
      ))}
      <line x1={x(0)} x2={x(0)} y1={8} y2={H - 28} className="zero-line" />
      <line x1={x(o.truth)} x2={x(o.truth)} y1={8} y2={H - 28} className="truth-line" />
      {rows.map((r, i) => {
        const cy = 8 + rowH * i + rowH / 2
        return (
          <g key={r.name} className={r.cls} data-tip={`${r.name}: ${f(r.mid)} ${unit}${r.lo !== r.hi ? `, 95% CI ${f(r.lo)} to ${f(r.hi)}` : ''}`}>
            <text x={0} y={cy - 2} className="est-name">{r.name}</text>
            {!compact && <text x={0} y={cy + 14} className="est-detail">{r.detail}</text>}
            <rect x={L} y={cy - 18} width={W - L - R} height={36} fill="transparent" />
            {r.lo !== r.hi && <line x1={x(r.lo)} x2={x(r.hi)} y1={cy} y2={cy} className="est-bar" />}
            <circle cx={x(r.mid)} cy={cy} r="8" className="est-dot" />
            <text x={x(r.mid)} y={cy - 14} textAnchor="middle" className="est-value">{f(r.mid)}</text>
          </g>
        )
      })}
    </svg>
  )
}

/** How likely a run of each length is to detect the chosen effect. */
export function PowerChart({ effect, seSwitchback, seNaive, days, unit }: { effect: number; seSwitchback: number; seNaive: number; days: number; unit: string }) {
  const p = PLOT
  const maxDays = 60
  const x = (d: number) => p.l + ((d - 1) / (maxDays - 1)) * (p.w - p.l - p.r)
  const y = (v: number) => p.h - p.b - v * (p.h - p.t - p.b)
  const at = (d: number, se: number) => powerAt(effect, se * Math.sqrt(days / d))
  const path = (se: number) => Array.from({ length: maxDays }, (_, i) => `${i ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(at(i + 1, se)).toFixed(1)}`).join('')
  const [hover, setHover] = useState<number | null>(null)
  return (
    <ChartFrame title="Power by experiment length" sub={`Chance of detecting ${Math.abs(effect).toFixed(2)} ${unit} at 95% confidence. Standard error shrinks with the root of the days run.`}
      legend={<><Key color="var(--a)" label="Switchback" /><Key color="var(--muted)" label="Naive A/B, overconfident" dash /></>}>
      <svg viewBox={`0 0 ${p.w} ${p.h}`} role="img" aria-label="Power curves against days of experiment"
        onMouseMove={e => {
          const box = e.currentTarget.getBoundingClientRect()
          const u = ((e.clientX - box.left) / box.width) * p.w
          setHover(Math.max(1, Math.min(maxDays, Math.round(((u - p.l) / (p.w - p.l - p.r)) * (maxDays - 1)) + 1)))
        }}
        onMouseLeave={() => setHover(null)}>
        <Grid p={p} xTicks={[1, 10, 20, 30, 40, 50, 60]} yTicks={[0, 0.2, 0.4, 0.6, 0.8, 1]} x={x} y={y} xLabel="Days of experiment" yLabel="Power" yf={v => `${Math.round(v * 100)}%`} />
        <line x1={p.l} x2={p.w - p.r} y1={y(0.8)} y2={y(0.8)} className="zero-line" />
        <path d={path(seNaive)} className="series dashed" stroke="var(--muted)" />
        <path d={path(seSwitchback)} className="series" stroke="var(--a)" />
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={p.t} y2={p.h - p.b} className="crosshair" />
            <circle cx={x(hover)} cy={y(at(hover, seSwitchback))} r="4.5" fill="var(--a)" stroke="var(--surface)" strokeWidth="2" />
            <rect x={p.l} y={p.t} width={p.w - p.l - p.r} height={p.h - p.t - p.b} fill="transparent"
              data-tip={`${hover} days: switchback ${Math.round(at(hover, seSwitchback) * 100)}%, naive ${Math.round(at(hover, seNaive) * 100)}%`} />
          </g>
        )}
      </svg>
    </ChartFrame>
  )
}

/** The randomized calendar: one row per region, one cell per switchback window. */
export function SwitchbackGrid({ grid, regions, windows, windowMin, labelA, labelB }: { grid: GridCell[]; regions: number; windows: number; windowMin: number; labelA: string; labelB: string }) {
  const lookup = new Map(grid.map(c => [`${c.region}:${c.window}`, c]))
  return (
    <ChartFrame title="The randomized time-region units, day one" sub={`${regions} regions by ${windows} windows of ${windowMin} minutes. Each cell is one experimental unit.`}
      legend={<><Key color="var(--a)" label={`A: ${labelA}`} /><Key color="var(--b)" label={`B: ${labelB}`} /></>}>
      <div className="sb-grid" style={{ gridTemplateColumns: `64px repeat(${windows}, minmax(0, 1fr))` }} role="img" aria-label="Calendar of which strategy ran in each region and time window">
        {Array.from({ length: regions }, (_, r) => (
          <div key={r} style={{ display: 'contents' }}>
            <span className="sb-row">Region {r + 1}</span>
            {Array.from({ length: windows }, (_, w) => {
              const c = lookup.get(`${r}:${w}`)
              return <i key={w} className={c ? (c.treated ? 'b' : 'a') : 'none'} data-tip={c ? `Region ${r + 1}, minute ${w * windowMin}: ${c.treated ? 'B' : 'A'}, ${c.orders} orders, ${c.value.toFixed(1)} min average` : 'No orders in this unit'} />
            })}
          </div>
        ))}
      </div>
    </ChartFrame>
  )
}

/** The three sides of the trade-off as a triangle: a bigger reach on a side is better for that side. */
export function TradeoffTriangle({ efficiency, food, pay, size = 180 }: { efficiency: number; food: number; pay: number; size?: number }) {
  const c = size / 2
  const R = size * 0.38
  const pt = (i: number, f: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3
    return `${(c + Math.cos(a) * R * f).toFixed(1)},${(c + 6 + Math.sin(a) * R * f).toFixed(1)}`
  }
  const v = [efficiency, food, pay].map(x => Math.max(0.08, Math.min(1, x)))
  return (
    <svg className="triangle" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
      aria-label={`Trade-off shape: efficiency ${Math.round(v[0] * 100)} of 100, food ${Math.round(v[1] * 100)}, courier pay ${Math.round(v[2] * 100)}.`}>
      {[0.33, 0.66, 1].map(f => <polygon key={f} points={[0, 1, 2].map(i => pt(i, f)).join(' ')} className="tri-grid" />)}
      <polygon points={v.map((f, i) => pt(i, f)).join(' ')} className="tri-shape" />
      {v.map((f, i) => { const [x, y] = pt(i, f).split(','); return <circle key={i} cx={x} cy={y} r="4.5" className="tri-dot" /> })}
    </svg>
  )
}
