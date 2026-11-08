import { useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from 'react'
import type { CityGeo } from './engine/city.ts'
import { go } from './App.tsx'
import { clockLabel, type Clock } from './clock.ts'
import { Scene, tempColor, type LiveStats } from './scene.ts'
import type { SimResult } from './engine/types.ts'

export function useTheme() {
  const [mode, setMode] = useState(() => document.documentElement.dataset.themeMode ?? 'light')
  useEffect(() => {
    const ob = new MutationObserver(() => setMode(document.documentElement.dataset.themeMode ?? 'light'))
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-mode'] })
    return () => ob.disconnect()
  }, [])
  return mode === 'dark'
}

export function ThemeToggle() {
  const dark = useTheme()
  return (
    <button
      className="icon-btn" type="button"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Light theme' : 'Dark theme'}
      onClick={() => {
        const next = dark ? 'light' : 'dark'
        document.documentElement.dataset.themeMode = next
        localStorage.setItem('themeMode', next)
      }}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
        {dark
          ? <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-5 1 3h-2l1-3Zm0 20-1-3h2l-1 3ZM2 12l3-1v2l-3-1Zm20 0-3 1v-2l3 1ZM4.9 4.9l2.8 1.4-1.4 1.4-1.4-2.8Zm14.2 14.2-2.8-1.4 1.4-1.4 1.4 2.8ZM4.9 19.1l1.4-2.8 1.4 1.4-2.8 1.4ZM19.1 4.9l-1.4 2.8-1.4-1.4 2.8-1.4Z" />
          : <path d="M21 14.5A9 9 0 0 1 9.5 3a9 9 0 1 0 11.5 11.5Z" />}
      </svg>
    </button>
  )
}

export const Monogram = () => <span className="monogram" aria-hidden="true">DL</span>

export function Link({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) {
  return (
    <a {...rest} href={href} onClick={e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return
      e.preventDefault()
      go(href)
    }}>{children}</a>
  )
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand"><Monogram /> <strong>Dispatch Lab</strong></div>
        <p>Built by Aryan Kansagara. Independent project, not affiliated with DoorDash.</p>
        <p className="footer-note">Streets and restaurant locations come from OpenStreetMap (&copy; OpenStreetMap contributors, ODbL). Orders, couriers, prep times and pay are seeded synthetic data generated in your browser. None of it is DoorDash data, and results describe this model, not any real marketplace.</p>
      </div>
    </footer>
  )
}

export const SyntheticBadge = ({ text = 'Synthetic data' }: { text?: string }) => (
  <span className="badge"><i aria-hidden="true" />{text}</span>
)

export function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01, format, hint }: {
  label: string; value: number; onChange(v: number): void; min?: number; max?: number; step?: number; format?(v: number): string; hint?: string
}) {
  const shown = format ? format(value) : String(value)
  return (
    <label className="slider">
      <span className="slider-head"><span>{label}</span><b>{shown}</b></span>
      <input
        type="range" min={min} max={max} step={step} value={value} aria-valuetext={shown}
        style={{ '--pct': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={e => onChange(Number(e.target.value))}
      />
      {hint && <span className="slider-hint">{hint}</span>}
    </label>
  )
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
export { reduced as prefersReducedMotion }

/** A live city on canvas. Draws only when the shared clock moves or something visual changes. */
export function CityMap({ result, city, clock, cover, focusX, selected = -1, onSelect, label, ariaLabel, children, startHour }: {
  result: SimResult | null; city?: CityGeo | null; clock: Clock; cover?: boolean; focusX?: number; selected?: number; onSelect?(c: number): void
  label?: ReactNode; ariaLabel: string; children?: ReactNode; startHour?: number
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<Scene | null>(null)
  const dark = useTheme()
  const opts = useRef({ selected, dark })
  opts.current = { selected, dark }
  const hud = useRef<HTMLDivElement>(null)
  const clockText = useRef<HTMLSpanElement>(null)

  const paint = useRef(() => {})
  paint.current = () => {
    const c = canvas.current
    const s = scene.current
    if (!c || !s) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    s.draw(ctx, clock.t, { selected: opts.current.selected, dark: opts.current.dark, dim: false })
  }

  const fit = useRef(() => {})
  fit.current = () => {
    const c = canvas.current
    const w = wrap.current
    if (!c || !w || !scene.current) return
    const { width, height } = w.getBoundingClientRect()
    if (width < 2 || height < 2) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    c.width = Math.round(width * dpr)
    c.height = Math.round(height * dpr)
    scene.current.layout(width, height, dpr, !!cover, focusX)
    paint.current()
  }

  useEffect(() => {
    if (!result) return
    const s = new Scene(result, city)
    scene.current = s
    fit.current()
    // Canvas text uses the web font, so repaint when it arrives.
    void document.fonts?.ready.then(() => paint.current())
  }, [result, city])

  useEffect(() => { paint.current() }, [dark, selected])

  useEffect(() => {
    const ro = new ResizeObserver(() => fit.current())
    if (wrap.current) ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let lastHud = 0
    const onTick = () => {
      paint.current()
      const now = performance.now()
      if (now - lastHud < 180) return
      lastHud = now
      const s = scene.current
      if (s && hud.current) writeHud(hud.current, s.stats(clock.t))
      if (clockText.current) clockText.current.textContent = clockLabel(clock.t, startHour)
    }
    onTick()
    return clock.subscribe(onTick)
  }, [clock, startHour, result])

  return (
    <div className="map" ref={wrap}>
      <canvas
        ref={canvas} role="img" aria-label={ariaLabel}
        className={onSelect ? 'clickable' : undefined}
        onClick={e => {
          if (!onSelect || !scene.current) return
          const box = e.currentTarget.getBoundingClientRect()
          onSelect(scene.current.pick(e.clientX - box.left, e.clientY - box.top, clock.t))
        }}
      />
      {!result && <div className="map-loading" role="status"><span className="spinner" /> Simulating the city</div>}
      {label && <div className="map-label">{label}</div>}
      {city && <a className="map-attrib" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">&copy; OpenStreetMap contributors</a>}
      <div className="map-hud">
        <span className="map-clock" ref={clockText}>{clockLabel(clock.t, startHour)}</span>
        <div className="map-stats" ref={hud} aria-hidden="true" />
      </div>
      {children}
    </div>
  )
}

function writeHud(el: HTMLElement, s: LiveStats) {
  const items: [string, number][] = [['at kitchens', s.waiting], ['in bags', s.carried], ['live stacks', s.stacksLive], ['delivered', s.delivered]]
  if (el.childElementCount !== items.length) {
    el.innerHTML = items.map(() => '<span><b></b><i></i></span>').join('')
  }
  items.forEach(([label, v], i) => {
    const span = el.children[i]
    span.children[0].textContent = String(v)
    span.children[1].textContent = label
  })
}

/** Reads the map's colour language: prep heats up, ready is hottest, then it cools. */
export function HeatLegend() {
  const stops = [74, 64, 56, 50, 42, 30].map(c => `${tempColor(c)}`).join(',')
  return (
    <div className="legend-row">
      <span className="legend-item"><i className="dot prep" /> Prepping</span>
      <span className="legend-heat">
        <span>Ready 74&deg;C</span>
        <i style={{ background: `linear-gradient(90deg,${stops})` }} />
        <span>Cold under 50&deg;C</span>
      </span>
      <span className="legend-item"><i className="dot courier" /> Courier</span>
      <span className="legend-item"><i className="line stack" /> Stack, linked route</span>
      <span className="legend-item"><i className="dot idle" /> Idle</span>
    </div>
  )
}
