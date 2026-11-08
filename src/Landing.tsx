import { useEffect, useMemo, useRef, useState } from 'react'
import { EstimateChart, FrontierChart, TradeoffTriangle } from './Charts.tsx'
import { startTask, useRun, type ExperimentOutput, type Request, type Source, type SweepOutput } from './client.ts'
import { Clock } from './clock.ts'
import { useCity } from './cities.ts'
import { configOf, DEFAULT_SETTINGS } from './engine/settings.ts'
import { CityMap, Footer, HeatLegend, Link, Monogram, prefersReducedMotion, Slider, SyntheticBadge, ThemeToggle } from './shared.tsx'

const HERO_SEED = 7
// The evidence section below runs on the fictional city, which needs no download.
const GRID_SOURCE: Source = { kind: 'scenario', id: 'dinner', seed: HERO_SEED }
const CFG = configOf({ ...DEFAULT_SETTINGS, seed: HERO_SEED })
const money = (v: number) => `$${v.toFixed(2)}`

const POSTS = {
  dispatch: 'https://careersatdoordash.com/blog/using-ml-and-optimization-to-solve-doordashs-dispatch-problem/',
  switchback: 'https://careersatdoordash.com/blog/switchback-tests-and-randomized-experimentation-under-network-effects-at-doordash/',
  causal: 'https://careersatdoordash.com/blog/supercharging-doordash-logistics-through-causal-ml-and-joint-optimization/',
}

function useVisible<T extends Element>() {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (!ref.current) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect() } }, { rootMargin: '240px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [])
  return [ref, seen] as const
}

function Hero() {
  const [batch, setBatch] = useState(0.5)
  const clock = useMemo(() => { const c = new Clock(); c.loop = true; c.speed = 3; return c }, [])
  const spec = { id: 'optimizer' as const, batch, fresh: 0.5, pay: 0 }
  const { city, error: cityError } = useCity('toronto')
  // The hero runs on real Toronto streets; if that file cannot load, the fictional city stands in.
  const source: Source | null = city ? { kind: 'scenario', id: 'dinner', seed: HERO_SEED, city } : cityError ? { kind: 'scenario', id: 'dinner', seed: HERO_SEED } : null
  const req: Request | null = source && { kind: 'run', source, spec, cfg: CFG }
  const run = useRun(req, `${city ? 'toronto' : 'grid'}/${batch}`)
  const m = run.data?.metrics
  const started = useRef(false)
  useEffect(() => {
    if (!run.data) return
    clock.setHorizon(run.data.result.horizon)
    if (started.current) return
    started.current = true
    clock.t = 70
    if (prefersReducedMotion()) clock.notify()
    else clock.play()
  }, [run.data, clock])
  // Offscreen, the animation stops so the page costs nothing while reading further down.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!box.current) return
    const io = new IntersectionObserver(([e]) => {
      if (prefersReducedMotion()) return
      if (e.isIntersecting) clock.play()
      else clock.pause()
    })
    io.observe(box.current)
    return () => { io.disconnect(); clock.pause() }
  }, [clock])

  return (
    <section className="hero" ref={box}>
      <CityMap result={run.data?.result ?? null} city={city} clock={clock} cover focusX={0.64} startHour={17}
        ariaLabel="Downtown Toronto's real streets and restaurants, with synthetic orders and couriers. Orders heat up while prepping, then cool until picked up. Stacked orders appear as linked red routes." />
      <div className="hero-copy">
        <SyntheticBadge text={city ? 'Live: real Toronto streets, synthetic orders' : 'Live simulation of a synthetic city'} />
        <h1>Every stack is a <em>trade-off.</em></h1>
        <p>Replay a city's delivery marketplace under any dispatch strategy, and see what batching really buys: efficiency, at the price of food quality and sometimes courier pay.</p>
        <div className="hero-cta">
          <Link href="/app" className="btn btn-red btn-big">Open the lab</Link>
          <a href="#why" className="btn btn-quiet btn-big">Why it matters</a>
        </div>
      </div>
      <div className="hero-panel">
        <Slider label="Drag the batching weight" value={batch} format={v => `${Math.round(v * 100)}`} onChange={setBatch} hint="This reruns the full simulator in a Web Worker as you drag." />
        <div className="hero-numbers" aria-live="polite">
          <div><span>Efficiency</span><b>{m ? m.courierMinPerDelivery.toFixed(1) : '--'}</b><small>courier min per delivery</small><small>{m ? `${Math.round(m.stackShare * 100)}% of orders in stacks` : ''}</small></div>
          <div><span>Food</span><b>{m ? `${m.tempMean.toFixed(1)}°` : '--'}</b><small>C at the door</small><small>{m ? `${Math.round(m.coldRate * 100)}% arrive cold` : ''}</small></div>
          <div><span>Courier</span><b>{m ? money(m.payPerActiveHour) : '--'}</b><small>per active hour</small><small>{m ? `${Math.round(m.hiddenLowPayRate * 100)}% of stacks hide a low-pay order` : ''}</small></div>
        </div>
        {m && <div className="hero-tri"><TradeoffTriangle efficiency={(26 - m.courierMinPerDelivery) / 12} food={(m.tempMean - 46) / 16} pay={(m.payPerActiveHour - 16) / 20} size={96} /><p>Top: efficiency<br />Right: food<br />Left: courier pay</p></div>}
      </div>
      <div className="hero-legend"><HeatLegend /></div>
    </section>
  )
}

function LiveEvidence() {
  const [ref, seen] = useVisible<HTMLDivElement>()
  const [sweep, setSweep] = useState<SweepOutput | null>(null)
  const [exp, setExp] = useState<ExperimentOutput | null>(null)
  useEffect(() => {
    if (!seen) return
    const a = startTask<SweepOutput>({ kind: 'sweep', source: GRID_SOURCE, spec: { id: 'optimizer', batch: 0.5, fresh: 0.5, pay: 0 }, cfg: CFG, steps: 9, days: 2 })
    const b = startTask<ExperimentOutput>({ kind: 'experiment', source: GRID_SOURCE, a: { id: 'hungarian', batch: 0, fresh: 0.5, pay: 0 }, b: { id: 'optimizer', batch: 0.5, fresh: 0.5, pay: 0 }, cfg: CFG, days: 4, regions: 2, windowMin: 30 })
    a.promise.then(setSweep).catch(() => {})
    b.promise.then(setExp).catch(() => {})
    return () => { a.cancel(); b.cancel() }
  }, [seen])
  const o = exp?.outcomes.deliveryMin
  const cost = exp?.outcomes.cost
  const stacked = exp?.outcomes.stacked
  return (
    <section className="evidence" ref={ref}>
      <div className="section-inner">
        <h2 className="display">Not a mockup. These are running now.</h2>
        <p className="lead">Both charts below just ran in your browser on the fictional grid city. They are model output, not measurements of any real marketplace.</p>
        <div className="evidence-grid">
          <article className="card">
            <h3>The Pareto frontier of the batching weight</h3>
            <p className="muted">Each number is a slider setting. Moving right saves courier time and costs heat at the door. Colour shows pay per active hour.</p>
            {sweep ? <FrontierChart points={sweep} compact /> : <div className="empty small-empty"><span className="spinner" /><p>Sweeping the slider</p></div>}
          </article>
          <article className="card">
            <h3>What interference does to an A/B test</h3>
            <p className="muted">Global matching against stacking on one shared fleet. Outcome: delivery time, in minutes.</p>
            {o && cost ? (
              <>
                <EstimateChart o={o} unit="min" compact />
                <p className="evidence-note">The naive test sees {Math.abs(o.naive.diff).toFixed(1)} min of the {Math.abs(o.truth).toFixed(1)} min truth. Split 50/50, stacking orders have half as many partners, so stack share rises {stacked?.naive.diff.toFixed(0)} points instead of the {stacked?.truth.toFixed(0)} a full rollout brings. On platform cost it reports {cost.naive.diff > 0 ? '+' : ''}{cost.naive.diff.toFixed(2)} dollars against a true {cost.truth > 0 ? '+' : ''}{cost.truth.toFixed(2)}.</p>
              </>
            ) : <div className="empty small-empty"><span className="spinner" /><p>Simulating 16 marketplace days</p></div>}
          </article>
        </div>
      </div>
    </section>
  )
}

export function Landing() {
  return (
    <div className="landing">
      <header className="topbar landing-bar">
        <Link className="brand" href="/" aria-label="Dispatch Lab home"><Monogram /><strong>Dispatch Lab</strong></Link>
        <div className="topbar-right">
          <ThemeToggle />
          <Link href="/app" className="btn btn-red btn-small">Open the lab</Link>
        </div>
      </header>
      <Hero />

      <section className="band" id="why">
        <div className="section-inner">
          <h2 className="display">The offer looks fine. The order inside it might not.</h2>
          <div className="band-grid">
            <p>Dashers publicly complain about low-paying orders hidden inside stacks and big batches. Customers publicly complain about cold food. Those two complaints and the efficiency gain are the same decision, seen from three sides of the marketplace.</p>
            <p>Dispatch Lab makes that decision something you can drag, replay and test before it reaches anyone's dinner.</p>
          </div>
        </div>
      </section>

      <section className="sides">
        <div className="section-inner">
          <div className="side-grid">
            <article><span className="side-num">1</span><h3>Batching efficiency</h3><p>Stack share, courier minutes and miles per delivery, utilization, and platform cost per delivery.</p></article>
            <article><span className="side-num">2</span><h3>Food quality</h3><p>Delivery time at p50 and p90, food wait after ready, late rate, and temperature at the door from a cooling curve.</p></article>
            <article><span className="side-num">3</span><h3>Courier pay</h3><p>Pay per active hour, online hour and mile, and the worst-paid order inside a stack: the hidden low-pay number an offer total never shows.</p></article>
          </div>
        </div>
      </section>

      <section className="sources">
        <div className="section-inner">
          <h2 className="display">Built on how DoorDash describes the problem</h2>
          <p className="lead">The questions come from DoorDash's public engineering writing. The data and the model here are entirely separate.</p>
          <div className="quote-grid">
            <blockquote>
              <p>Its scoring function is &ldquo;designed to recognize tradeoffs between efficiency (using Dasher time as efficiently as possible) and quality (getting deliveries to consumers as quickly as possible).&rdquo;</p>
              <cite><a href={POSTS.dispatch} target="_blank" rel="noreferrer">Using ML and Optimization to Solve DoorDash's Dispatch Problem, 2021</a></cite>
            </blockquote>
            <blockquote>
              <p>&ldquo;In most supply conditions, increasing batch rate may save Dasher cost by minimizing duplicative travel, but may simultaneously degrade delivery duration.&rdquo;</p>
              <cite><a href={POSTS.causal} target="_blank" rel="noreferrer">Supercharging DoorDash logistics through causal ML and joint optimization, 2026</a></cite>
            </blockquote>
            <blockquote className="quote-red">
              <p>&ldquo;Switchback experiments tend to have only moderate statistical power, which would mean running this randomized experiment at a large scale for multiple weeks.&rdquo;</p>
              <cite><a href={POSTS.causal} target="_blank" rel="noreferrer">Same post, 2026</a></cite>
            </blockquote>
            <blockquote>
              <p>With network effects, &ldquo;simple A/B tests are often ineffective.&rdquo; Switchback testing randomizes &ldquo;time-region units&rdquo; and uses a sandwich estimator of variance.</p>
              <cite><a href={POSTS.switchback} target="_blank" rel="noreferrer">Switchback Tests and Randomized Experimentation Under Network Effects at DoorDash, 2018</a></cite>
            </blockquote>
          </div>
        </div>
      </section>

      <LiveEvidence />

      <section className="features">
        <div className="section-inner">
          <h2 className="display">A marketplace you can take apart</h2>
          <div className="feature-grid">
            <article><h3>Discrete-event simulator</h3><p>Order arrival, prep with forecast error, assignment, pickup, multi-stop routes and delivery. Distance is haversine times a road factor, at a speed you set.</p></article>
            <article><h3>Four pluggable strategies</h3><p>Greedy nearest courier, batch at same store, a hand-rolled Hungarian matching each tick, and a score-weighted optimizer with sliders for batching, food and pay.</p></article>
            <article><h3>Switchback experiments</h3><p>Time-region randomization, cluster-robust confidence intervals, a power readout of how long to run, and the naive A/B beside it to expose the interference bias.</p></article>
            <article><h3>Sweep and apply</h3><p>Sweep the batching weight, plot the Pareto frontier, and click any point to apply it.</p></article>
            <article><h3>A map you can interrogate</h3><p>Couriers on a stylized street grid, orders heating and cooling, stacks as linked routes, a timeline scrubber, and any courier's route and pay on click.</p></article>
            <article><h3>Any real city, or your data</h3><p>Pick Toronto, New York, London and more, or search any place: real restaurants and streets come from OpenStreetMap and couriers drive the actual street network. Generate lunch rush, dinner, rain or a courier shortage on top, or paste your own CSV or JSON. Every run replays from a shareable URL and seed.</p></article>
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="section-inner">
          <h2 className="display">Run the marketplace before it runs you.</h2>
          <Link href="/app" className="btn btn-white btn-big">Open the lab</Link>
        </div>
      </section>
      <Footer />
    </div>
  )
}
