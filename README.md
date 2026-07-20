# Pipeline Rate Change Calculator

A fast, single-page calculator for figuring out **arrival times on a liquids
pipeline** — including what happens when the pump rate changes partway through a
run. Built for pipeline operators who need a quick, reliable ETA at the console
or on a phone in the field.

Live site: **[r-c-calculator.netlify.app](https://r-c-calculator.netlify.app)**

## What it does

The tool tracks product by **volume to go** (barrels between the current point
and the target) and flow rate in **barrels per hour (BPH)**. It has two modes:

### 1. Arrival Time
Enter the barrels to go, a start time, and the current rate. Add any number of
**scheduled rate changes** (e.g. "cut to 3,000 BPH at 12:00, back up to 5,000 at
18:00"). The calculator integrates the changing rate and tells you:

- the **estimated arrival** (clock time + date),
- a **live countdown** to arrival,
- **total run time**,
- how the rate changes shift the ETA **vs. holding the current rate steady**, and
- a **segment breakdown** showing barrels moved and barrels remaining through
  each rate step, with the arrival segment highlighted.

It also flags the case where flow stops (0 BPH) and the product never reaches the
target.

### 2. Required Rate
Enter barrels to go, a start time, and a **target arrival time**, and it returns
the **steady rate needed** to hit that time (in BPH, plus BPD and GPM). Enter your
current rate and it tells you how much to increase or reduce.

## How the math works

- Arrival happens when cumulative pumped volume equals the volume to go.
- Between rate changes the flow is treated as **steady** (piecewise-constant).
- A segment at rate `Q` (BPH) lasting `t` hours moves `Q × t` barrels; the engine
  walks the segments until the running total reaches the volume to go, then solves
  for the exact arrival moment inside the final segment.
- All times use your **device's local time zone**.

The calculation engine lives in [`calc.js`](calc.js) as pure, dependency-free
functions and is covered by unit tests in [`calc.test.mjs`](calc.test.mjs).

## Project layout

| File | Purpose |
|------|---------|
| `index.html` | The whole UI (HTML + CSS + app JS, no build step). |
| `calc.js` | Pure calculation engine (ES module), imported by the UI and the tests. |
| `calc.test.mjs` | Unit tests for the engine. |
| `netlify.toml` | Static-deploy config (publish from repo root). |

## Local development

The UI imports `calc.js` as an ES module, so serve it over HTTP (opening the file
directly with `file://` will block the import):

```bash
# serve locally
python3 -m http.server 8000
# then open http://127.0.0.1:8000

# run the calculation tests
npm test        # (node --test)
```

## Deploying

The site is currently deployed to the Netlify project **`r-c-calculator`**. The
existing deploy was a manual drag-and-drop; the recommended setup going forward is
to **connect this GitHub repo to that Netlify site** so every push publishes
automatically:

1. Netlify → the `r-c-calculator` project → **Site configuration → Build & deploy
   → Link repository**.
2. Pick this repo and the deploy branch.
3. No build command is needed — `netlify.toml` publishes the repo root.

Alternatively, you can still drag the project folder onto the Netlify dashboard to
deploy manually.
