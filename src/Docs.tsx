import { useEffect } from 'react'
import { Footer, Link, Monogram, ThemeToggle } from './shared.tsx'

const MEITUAN = 'https://github.com/meituan/Meituan-INFORMS-TSL-Research-Challenge'
const KAGGLE = 'https://www.kaggle.com/datasets/gauravmalik26/food-delivery-dataset'
const OVERPASS = 'https://wiki.openstreetmap.org/wiki/Overpass_API'

export default function Docs() {
  // The page loads lazily, so the browser's own jump to #section happens before the section exists.
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView() }, [])
  return (
    <div className="docs-page">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Dispatch Lab home"><Monogram /><strong>Dispatch Lab</strong></Link>
        <div className="topbar-right">
          <ThemeToggle />
          <Link href="/app" className="btn btn-red btn-small">Open the lab</Link>
        </div>
      </header>
      <main className="docs">
        <h1>How Dispatch Lab works</h1>
        <p className="lead">What is real, what is synthetic, which files it reads, and where every reference number comes from.</p>

        <h2 id="real">What is real and what is not</h2>
        <ul>
          <li><strong>Real:</strong> streets and restaurant locations in the bundled cities, from OpenStreetMap through the <a href={OVERPASS}>Overpass API</a>, baked on 7 November 2026. Searched places are fetched live. &copy; OpenStreetMap contributors, ODbL.</li>
          <li><strong>Synthetic:</strong> orders, couriers, prep times, tips and pay in the built-in scenarios. They are seeded, so the same seed always gives the same day.</li>
          <li><strong>Yours:</strong> anything you import. It is parsed and simulated in your browser and never leaves it.</li>
        </ul>

        <h2 id="formats">Import formats</h2>
        <h3>Generic CSV or JSON</h3>
        <p>One row per order with a created time, store and customer coordinates and prep minutes. Column names are matched loosely, so <code>store_lat</code>, <code>pickup_latitude</code> and <code>Restaurant_latitude</code> all work. Times can be minutes from the start, <code>HH:MM</code>, ISO timestamps or Unix epoch seconds or milliseconds. A separate date column (<code>2024-03-19</code> or day-first <code>19-03-2022</code>) is combined with clock times. Without a prep column, the time from order to pickup is used instead. An optional <code>payout</code> replaces the pay model, and a recorded delivery time (<code>delivery_min</code>, <code>Time_taken(min)</code>) is shown beside the simulated one.</p>
        <p>Couriers are optional: shift start, shift end and a start position. Without them, an assumed fleet of one courier per 6.5 orders is added and labelled.</p>
        <p>Cleaning rules: rows with a store or customer at 0,0, or a store over 50 km from its customer, are skipped as broken coordinates. A file covering several cities keeps the busiest one, and a file covering several days keeps the busiest day. Every skip is reported. Limits are 5,000 orders and 800 couriers per run.</p>

        <h3>Meituan waybills</h3>
        <p><a href={MEITUAN}>Meituan's open dataset</a> for the 2025 INFORMS TSL Data-Driven Research Challenge (<code>all_waybill_info_meituan_0322.csv</code>, CC BY-NC 4.0; download and unzip it yourself, it is not redistributed here) loads as it comes. The file has one row per dispatch offer, about 654,000 offers over 8 days and 23 delivery areas, so the importer:</p>
        <ul>
          <li>keeps the busiest delivery area on its busiest day, then its busiest two clock hours (China time, UTC+8) if that is still over 5,000 orders;</li>
          <li>merges repeat offers of the same order, keeping the one a courier accepted and delivered;</li>
          <li>divides coordinates by 10<sup>6</sup> and reads Unix-second times;</li>
          <li>uses <code>estimate_meal_prepare_time</code> minus <code>platform_order_time</code> as prep, giving the median to the few rows where that estimate is zero or garbled;</li>
          <li>skips pre-booked orders, and builds couriers from the riders who accepted an offer, from their first acceptance to their last drop-off;</li>
          <li>reports the recorded delivery times (<code>arrive_time</code> minus <code>platform_order_time</code>) beside the simulated ones.</li>
        </ul>
        <p>Meituan publishes the coordinates shifted, so the map shows the right shape in the wrong place. This research was supported by data provided by Meituan.</p>

        <h3>Kaggle food delivery layout</h3>
        <p>The widely copied <a href={KAGGLE}>food delivery dataset</a> layout (<code>Restaurant_latitude</code>, <code>Delivery_location_latitude</code>, <code>Order_Date</code>, <code>Time_Orderd</code>, <code>Time_Order_picked</code>, <code>Time_taken(min)</code>) loads directly. Its known problems are handled: <code>NaN</code> times are reported and skipped, restaurant coordinates with flipped signs or zeros are dropped by the 50 km rule, and its many Indian cities and dates are cut to the busiest city-day, which is about 100 orders.</p>

        <h2 id="reference">Reference numbers</h2>
        <p>From the full Meituan file (546,364 delivered on-demand orders, 17 to 24 October 2022), computed on 15 November 2026:</p>
        <div className="table-wrap">
          <table className="metrics">
            <thead><tr><th scope="col">Measure</th><th scope="col" className="num">Meituan</th><th scope="col" className="num">Simulator default</th></tr></thead>
            <tbody>
              <tr><th scope="row">Delivery time p50, order to door</th><td className="num">27.9 min</td><td className="num">Depends on strategy</td></tr>
              <tr><th scope="row">Delivery time p90</th><td className="num">45.8 min</td><td className="num">Depends on strategy</td></tr>
              <tr><th scope="row">Store to customer, straight line, median (busiest area-day)</th><td className="num">1.8 km</td><td className="num">Up to 3 km city radius</td></tr>
              <tr><th scope="row">Kitchen prep estimate, median</th><td className="num">12.1 min</td><td className="num">13 min, lognormal</td></tr>
              <tr><th scope="row">Door-to-door straight-line speed, single orders, median</th><td className="num">10.7 km/h</td><td className="num">17.8 km/h (24 km/h over a 1.35 road factor)</td></tr>
            </tbody>
          </table>
        </div>
        <p>The speed row includes parking, walking and handover time, which the simulator models separately as 2 minutes at pickup and 1.5 at drop-off. Dense-city scooter delivery is slower than the default, so when replaying Meituan data, lower the speed under World settings until the recorded p50 lines up.</p>

        <h2 id="model">Model</h2>
        <ul>
          <li><strong>Distance:</strong> haversine distance times a road factor (default 1.35). Routed OpenStreetMap paths in the bundled cities average 1.30 to 1.44 times straight-line, measured with the bake script.</li>
          <li><strong>Food temperature:</strong> Newton cooling from 74&deg;C toward a 22&deg;C room, at 3.5% of the gap per minute on the shelf and 2% in an insulated bag. Below 50&deg;C counts as cold. These are stated assumptions, not measurements.</li>
          <li><strong>Pay:</strong> max(minimum base, base plus a per-mile rate on the miles an order adds to the route) plus tip. Defaults: $2 base, $0.70 per mile, $2 floor. An order paying under $4 inside a stack counts as hidden low pay.</li>
          <li><strong>Promise:</strong> the kitchen's ready time plus the direct drive, pickup and drop-off, plus a 14 minute buffer. Late means delivered after it; badly late (15 minutes past) or cold triggers a $4 platform credit.</li>
          <li><strong>Experiments:</strong> switchback assignment over time-region cells, difference in means with a CR1 cluster-robust variance and Student t critical values on clusters minus one degrees of freedom; power from the normal approximation.</li>
        </ul>

        <h2 id="sources">Sources</h2>
        <ul>
          <li><a href={MEITUAN}>Meituan INFORMS TSL Research Challenge data</a>, CC BY-NC 4.0, accessed 15 November 2026.</li>
          <li><a href={KAGGLE}>Food Delivery Dataset</a> on Kaggle, layout checked against a public copy on 15 November 2026.</li>
          <li><a href="https://careersatdoordash.com/blog/using-ml-and-optimization-to-solve-doordashs-dispatch-problem/">Using ML and Optimization to Solve DoorDash's Dispatch Problem</a>, 2021.</li>
          <li><a href="https://careersatdoordash.com/blog/switchback-tests-and-randomized-experimentation-under-network-effects-at-doordash/">Switchback Tests and Randomized Experimentation Under Network Effects at DoorDash</a>, 2018.</li>
          <li>Cameron, Gelbach and Miller, Bootstrap-Based Improvements for Inference with Clustered Errors, 2008, for the few-cluster correction.</li>
        </ul>
        <p className="muted">Independent project, not affiliated with DoorDash or Meituan.</p>
      </main>
      <Footer />
    </div>
  )
}
