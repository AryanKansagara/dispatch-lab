# Dispatch Lab

Replay a city's delivery marketplace under different dispatch strategies and see the three-way trade-off between batching efficiency, food quality and courier pay.

Live: https://dispatch-lab-tan.vercel.app

Independent project, not affiliated with DoorDash. Streets and restaurant locations are real, from OpenStreetMap. Orders, couriers, prep times and pay are seeded synthetic data. None of it is DoorDash data, and results describe this model, not any real marketplace.

## The pain

DoorDash's engineering blog describes a scoring function that trades off efficiency against quality, calls batch rate a key lever that can save Dasher cost while degrading delivery duration, and says switchback experiments "tend to have only moderate statistical power". Dashers publicly complain about low-paying orders hidden in stacks and big batches, and customers complain about cold food. This tool puts all of that on one screen.

Sources: [dispatch (2021)](https://careersatdoordash.com/blog/using-ml-and-optimization-to-solve-doordashs-dispatch-problem/), [switchback tests (2018)](https://careersatdoordash.com/blog/switchback-tests-and-randomized-experimentation-under-network-effects-at-doordash/), [causal ML and joint optimization (2026)](https://careersatdoordash.com/blog/supercharging-doordash-logistics-through-causal-ml-and-joint-optimization/).

## Features

- Real cities: Toronto, New York, San Francisco, Chicago, Los Angeles, Vancouver, Montreal, Waterloo and London ship ready to load, and search reaches any place OpenStreetMap knows (fetched live from Overpass, cached in the browser). Kitchens are real mapped restaurants, customers sit on real residential streets within 3 km of the centre, and only the main connected street network is kept, so no order lands across a river with no mapped bridge.
- Couriers on the map follow the street network (A* over the OpenStreetMap graph, routed lazily as legs are drawn). Across the bundled cities real routes average 1.3 to 1.44 times straight-line distance, which is where the simulator's default 1.35 road factor sits.
- Scenarios on top of any city: lunch rush, dinner peak, rain, courier shortage, or a fictional grid city. Or paste or upload CSV or JSON of your own orders and couriers.
- Discrete-event simulator: arrival, prep with forecast error, assignment, pickup, multi-stop routes, delivery. Distance is haversine times a road factor at a configurable speed.
- Strategies: greedy nearest courier, batch at same store, hand-rolled Hungarian matching each tick, and a score-weighted optimizer with batching, food and pay sliders.
- Metrics: delivery p50 and p90, food wait, temperature at the door from a cooling curve, late rate, utilization, pay per active hour, online hour and mile, stack share, worst-paid order inside a stack, platform cost per delivery.
- Experiment mode: switchback over time-region units, difference in means with a cluster-robust CI, power readout, and a naive A/B beside the simulator's true effect to expose interference bias.
- Sweep: Pareto frontier of the batching weight. Click a point to apply it.
- Canvas city map with couriers, heating and cooling orders, linked stack routes, scrubber, speed control, courier drill-down and side-by-side compare.
- Runs in Web Workers. Settings and seed live in a shareable URL. Light and dark themes.

## Model assumptions

Drive times use straight-line distance times the road factor, not the routed path, so the simulator stays fast enough to rerun as you drag a slider; the routed streets are what you see on the map. Pay is a stated model: base plus marginal route miles, floored, plus tip. Prep forecasts have noise, but there are no declines, traffic or parking models. Uploaded payouts are used as given. Treat outputs as a way to reason about trade-offs, not as forecasts.

## Run locally

```bash
npm install
npm run dev
npm test
npm run build
```

Refresh the bundled cities from OpenStreetMap with `node scripts/bake-cities.ts` (live from Overpass), or from local extracts converted to Overpass-style JSON with `node scripts/bake-cities.ts --from <dir>`.

Map data &copy; OpenStreetMap contributors, available under the Open Database License.
