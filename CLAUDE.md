# Engineering notes

What this site rests on and why it is shaped the way it is. `README.md` says
what it does; this says what a future edit needs to know first. Live at
**https://oceansensing.org/usv/**.

Almost everything here was **measured against the live server**, and several
of the measurements contradict what the obvious design would have assumed.
Where a number appears, it was taken rather than estimated. Dates on
measurements matter: the PMEL archive grows, and a figure taken in August
2026 is a figure about August 2026.

---

## 1. The shape of the thing

### The build fetches; the browser reads

**`data.pmel.noaa.gov` sends no `Access-Control-Allow-Origin` header**, on
any response, including an `OPTIONS` preflight. Measured 2026-08-19 with an
`Origin` header set:

```
PMEL   200 → (absent)                IOOS   200 → Access-Control-Allow-Origin: *
PMEL   OPTIONS → Allow: GET, HEAD, POST, OPTIONS   (and nothing else)
```

So the design the sibling glider site uses — the reader's browser asks the
ERDDAP directly — **is not available here**, and no amount of client-side
work recovers it. `scripts/build-catalog.mjs` and `scripts/build-series.mjs`
fetch under Node, where the same-origin policy does not apply, and write
`public/data/`. Everything the browser loads is same-origin.

Three consequences a later edit must not undo:

- **`connect-src` is `'self'` and must stay that way.** A cross-origin
  fetch reintroduced here will work under Node, pass every test, and fail
  only in a real browser. The CSP is what turns that into an error you can
  see.
- **`public/data/` is gitignored and generated.** It is ~200 MB of JSON
  derived from an upstream that is its own source of truth.
- **Freshness is a schedule, not a property of the page.** Every page states
  when its data was fetched, because a reader looking at an active hurricane
  mission needs to know whether they are seeing this hour or yesterday.

### One shape below the fetch

Everything below the data layer consumes the same thing, whichever vendor
and whichever naming era it came from:

```ts
interface Series {
  time: Float64Array;           // epoch seconds
  columns: Map<string, Float64Array>;   // keyed by CANONICAL name
  variables: Plottable[];
  findings: Finding[];
}
```

Keyed by **canonical** name is the load-bearing word. `usv-vars` resolves
`TEMP_SBE37_MEAN`, `sbe37_temperature_filtered` and `TEMP_SEA_FILTERED_MEAN`
to one `sea_water_temperature`, and it happens at build time, once, so no
figure and no page ever contains a vendor's spelling. **A change that leaks
a vendor column name into the render layer breaks the campaign page
silently** — it will still compile, and one vendor's vehicles will simply
stop appearing on a shared axis.

### Pages

| route | what it is |
|---|---|
| `/` | the fleet: a map of real tracks, and a searchable table of 153 deployments |
| `/vehicle/?dataset=<id>` | one deployment, driven entirely by the query string |
| `/campaign/?id=<slug>` | the vehicles that flew together, on shared axes |
| `/qc/` | every finding in the archive, ranked |
| `/about/` | the sources, the units, and what the QC does and does not claim |

---

## 2. What a request to PMEL costs

Measured 2026-08-19. **There is a strong server-side cache and it dominates
every other effect**, so a number taken once is not a measurement:

| | cold | warm |
|---|---|---|
| `sd1057_hurricane_2024`, 3 columns, 190,564 rows | **43.1 s** | **9.1 s** |
| `sd1041_hurricane_2024`, 1/hour decimated | **61.4 s** | **12.9 s** |

Warm, against `sd1041_hurricane_2024` — 226 days, 324,843 rows:

| request | bytes | wall |
|---|---|---|
| 3 columns, full rate | 12.7 MB | 12.8 s |
| **all 77 columns, full rate** | **132.7 MB** | 17.9 s |
| 3 columns, `orderByClosest("time/1hour")` | 0.21 MB | 12.9 s |
| 19 columns, `orderByClosest("time/20minutes")` | 2.1 MB | 17.4 s |

And against `sd1030_hurricane_2026` — 30 days, 42,003 rows:

| request | bytes | wall |
|---|---|---|
| all 52 columns, full rate | 12.5 MB | 1.7 s |
| 6 columns, full rate | 2.7 MB | 1.0 s |

Three facts fall out, and the third is the one that shaped the fetcher:

1. **Columns are the dominant lever.** 3 columns against 77 is a factor of
   ten in bytes on the same rows. Asking for `*` is never right.
2. **`orderByClosest` saves bytes and not server time** — 12.9 s against
   12.8 s for sixty times fewer rows. It is applied after the read, exactly
   as the Glider DAC's depth bin is. So it is a transfer-size mechanism, not
   a speed one.
3. **Server time scales with the span asked for.** About 1/25th of a second
   per thousand rows scanned, near enough linear, cache aside.

### The decimation ladder is a multiple of five minutes, and that is not arbitrary

A Saildrone's SBE37 reports every five minutes into a one-minute record, so
**80.2 % of full-rate rows have no sea temperature in them**. Decimating
with `orderByClosest` picks the row nearest each interval boundary — so an
interval that is a multiple of the sensor's own period lands *on* the
reporting rows, and one that is not lands between them.

Measured on `sd1030_hurricane_2026`, the same five-day window:

| | full rate | `time/20minutes` |
|---|---|---|
| rows | 7,201 | 361 |
| `wind_speed_world_filtered` missing | 0.8 % | 0.8 % |
| **`sbe37_temperature_filtered` missing** | **80.2 %** | **0.8 %** |

Decimation made the sea-temperature record *denser*, not sparser, because
it stopped sampling the gaps. `LADDER` in `packages/erddap-pmel/fetch.ts` is
therefore `[1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360]` minutes and every
rung above 2 divides by 5. **A rung of 7 or 25 minutes would quietly return
a mostly-empty CTD record**, and nothing on screen would say why.

### Two API facts that break a client written from the documentation

- **An empty result is an HTTP 404**, with `message="Not Found: Your query
  produced no matching results."` in the body. A window with no rows — a
  vehicle on the surface, a day of no telemetry — is not a transport
  failure, and a fetcher that treats it as one reports a whole deployment as
  broken. Unlike on the Glider DAC this is readable, because the fetch runs
  under Node where CORS does not apply.
- **`allDatasets` takes no paging parameters.** `page`/`itemsPerPage` belong
  to the HTML form and are a 400 here. It also carries a row for itself,
  which is dropped.

More in `packages/erddap-pmel/CLAUDE.md`.

---

## 3. How the data is stored

### JSON of rounded numbers, and it beats a binary format

The obvious encoding for a few million measurements is a typed array. It is
the wrong one. Measured on the worst case in the archive —
`sd1041_hurricane_2024`, 16,247 rows × 18 science columns:

| encoding | raw | **gzipped** |
|---|---|---|
| CSV as ERDDAP sent it | 2,080,653 | 482,325 |
| Float32 columnar binary | 1,169,784 | 356,283 |
| int16 quantized binary | 584,892 | 258,255 |
| **JSON, each column rounded to its own precision** | 1,695,889 | **315,473** |

JSON gzips *smaller than Float32* because rounding a column to the precision
its instrument actually resolves leaves short, repetitive tokens, and gzip
eats those. It costs no decode step beyond `JSON.parse`, it is readable when
something looks wrong, and — the part that decides it — **GitHub Pages
compresses `application/json` and does not compress
`application/octet-stream`**, confirmed against the live sibling site:

```
GET /gliders/data/deployments.json → content-encoding: gzip
```

A binary format would have shipped 1.2 MB where JSON ships 315 KB.

int16 quantization is 18 % smaller again and is not used: it makes every
value a lie at the last digit, needs a scale and offset per column to be
read at all, and buys 57 KB on the largest file in the archive.

### The point budget

Each dataset is decimated to **at most 8,000 time steps**, chosen from the
ladder above. At 1240 px that is six points per pixel — past the point where
a finer series changes the picture — and it bounds the archive at about
200 MB rather than the 2 GB full rate would need.

**The QC runs before the decimation**, on the finest rung the fetch budget
allows (native for anything under about 100 days, 5 minutes for the long
archive records). So a one-minute pressure spike is *found* at one minute
and *drawn* on an eight-thousand-point series, as an annotation rather than
a sample that may or may not have survived. Each dataset records the
resolution its QC ran at and the page prints it: a check that did not look
at a rate must not imply it did.

---

## 4. The physics

### Units, and the ones that are wrong upstream

The archive is not internally consistent and three of the inconsistencies
are silent:

- **Oshen wind is in knots**, at a **0.66 m** sensor height. Saildrone wind
  is m/s at ~3.4 m, published per record in
  `wind_measurement_height_filtered`. Comparing them without adjusting is a
  31 % error on the Oshen; `derive.ts` puts both on U10 through a neutral
  log profile before anything shares an axis.
- **Oshen `relative_humidity_mean` declares `units = 1`** and publishes
  percent — values of 82.0, quantized to 1 %. Taken at face value it is a
  humidity of 8,200 %. `usv-vars` overrides it and `usv-qc` reports it as a
  metadata finding rather than fixing it quietly.
- **Chance publishes no units at all** on `BARO_PRES_FILTERED_MEAN` (values
  ~1002, so hPa), `CHLOR_FILTERED_MEAN` and the wind components. Inferred
  from the canonical variable, and reported.

`packages/usv-vars/units.ts` is the only place any of this is written down.
Nothing else should grow a copy.

### There is no depth, and the pressure is not a depth

Every variable named `pressure` on a USV is **atmospheric**. The one trap
this creates is TEOS-10: the surface seawater properties are computed at
p = 0 dbar, and a barometric pressure fed to a seawater routine is a density
error of about 0.5 kg/m³ with nothing to signal it. `derive.ts` takes the
sea pressure as a constant zero and says so rather than reading a column.

---

## 5. Drawing

The plot engine, the colormaps, the PNG export and the TEOS-10
implementation are the sibling glider site's, vendored; `packages/plot/CLAUDE.md`
is its own note and `check:vendored` compares the copies against the source.
`src/lib/figure.ts`, `track.ts`, `track-legend.ts` and `map-export.ts` are
*adapted* copies rather than vendored ones — they are site code, and the two
sites' versions are each their own.

### There are no sections, and that is most of the difference

These are surface vehicles. Nothing on this site has a depth axis, so the
figures are **time series along a track** rather than sections through water.
Which changes what the page has to do: a section is one figure, and six time
series that do not share an x axis are six figures a reader has to align by
eye. The vehicle page stacks them on one clock.

### The stack is cloned from a rendered instance, not from a `<template>`

A compiled Astro component cannot be instantiated at runtime and the number
of series on screen is the reader's choice, so the stack clones a
`PlotFigure`. The prototype is a **real instance in the page**, hidden:
Astro stamps its scoping attribute onto what it renders, `cloneNode` copies
attributes, and a clone taken from a `<template>` carries none and loses
every scoped rule.

`data-figure` goes on the `PlotFigure` inside the clone and **not** on the
wrapper. Setting it on both makes every query for the figures on screen
return two elements per panel.

### A colour axis may legitimately be nothing

`fillAxes` used to resolve an empty choice the way the x and y axes do — fall
through to `options[0]`. That makes the "none" option unreachable, and every
panel in the stack silently coloured by the first variable in the list: a
line plot of pressure came back reporting how many samples had no wind speed.
The colour select now keeps `''` when that is what was asked for.

### Several vehicles on one plot

The engine draws one series. The campaign page draws N by **concatenating
them with a NaN row between** — the engine already lifts its pen over a gap
rather than drawing a chord, so one series is N lines — and colouring by the
vehicle's index, which makes the roster beside the figure its legend.

The comparison column is always called `value` whatever quantity it holds.
The figure binds its axes to column *names* at construction, so a menu that
renamed the column would need the figure torn down and rebuilt on every
change: new listeners on the same DOM, and the reader's colormap and limits
thrown away.

### A direction takes `hsv`

A bearing wraps, so 359° and 1° must come out nearly the same colour. Every
sequential map puts them at opposite ends of the ramp and draws a
discontinuity across due north that is not in the data.

### The map markers are the one set of colours not judged against the page

`--map-here`, `--map-past` and `--map-ring` are absent from the dark-theme
block deliberately: a dot on the map is on Esri's tiles, which have one
palette and do not know the theme exists. `test:contrast` holds them to 3:1
against the five colours the basemap actually renders.

---

## 6. The tests

Plain Node scripts, no framework, run through type stripping against the
TypeScript sources — a runner needing its own transform would put a build
between the code and its check. All offline; fixtures in `scripts/fixtures/`
are real PMEL responses captured 2026-08-19.

| suite | what it protects |
|---|---|
| `test:erddap` | query construction, the CSV parse, 404-means-empty, the ladder |
| `test:vars` | that every naming era resolves to the same canonical variable |
| `test:qc` | each check against a record whose faults are known |
| `test:derive` | U10, wind stress, humidity and the TEOS-10 surface set |
| `test:plot` | windows vs rescaling, reported decimation, robust limits, colormap names |
| `test:contrast` | every colour pair that ships |
| `test:pages` | the base path, the CSP, and every CSS rule jsdom cannot see |

`npm run verify` chains build, type-check, the doc gate and all seven.
`check:vendored` is run by hand: it compares the copied packages against the
sibling repository, which is not present in CI.

---

## 7. Things that were wrong, and how they looked

Each was written, run, and found to be wrong. Each now has a gate.

- **Five colormap names did not exist.** `cmo.phase`, `cmo.amp`, `cmo.tempo`,
  `cmo.oxy`, `cmo.topo` — only eleven cmocean maps ship in `@c4po/plot` and
  none of those five is among them. `sample()` falls back to viridis rather
  than throwing, so every affected quantity would have drawn a perfectly good
  plot in entirely the wrong colours with nothing anywhere saying so.
  *Gate:* `test:vars` and `test:plot` compare every name against the table.
- **`\b` is the wrong word boundary for `SCREAMING_SNAKE`.** An underscore is
  a word character, so `/\bsbe37\b/` never matches inside `TEMP_SBE37_MEAN`.
  Every Saildrone CTD came back with no sensor, the primary-sensor ranking
  tied on the default, and a stable sort returned the right answer *by
  accident of column order*. *Gate:* `test:vars` asserts recognition, not
  just the ranking it feeds.
- **A colour axis of "none" was unreachable.** Above, in §5.
- **The stack's wrapper duplicated `data-figure`.** Above, in §5.
- **Probing a record's cadence at one end is not enough.** `oshenPD22`
  reports every two minutes on 2026-08-07 and every ten by 2026-08-19;
  probing only the end concluded ten and chose a rung too coarse to see the
  two-minute half of the mission. Both ends now, and the finer wins.
- **A 0–360 range reported a whole convention as 5,636 impossible values.**
  Several Chance bearing columns are published on −180…180. Both are
  standard; the range spans both and a note says which a record used.
- **`silent` fired on every historic record in the archive.** A record that
  ended eight months ago is archived, not silent — 130-odd findings all
  saying the same thing, pushing the live ones off the page.
- **Nine identical findings for one event.** A Chance payload stopping on
  2026-01-27 produced one "no data since" per column. Instruments that stop
  within the same day are now grouped.
- **Two `h1` elements on the campaign page.** The list and the one-campaign
  view share a document and only one is ever shown — but a hidden heading is
  still a heading. *Gate:* `test:pages` counts them.
- **`unitFault` matched the damage rather than the legitimate set.** Written
  that way round, `m s-1` is flagged for its hyphen. It now tests for a
  non-ASCII character that is *not* one a unit may contain.
- **The site's own `tokens.css` had drifted from the sibling's** and was
  missing the three map-marker colours entirely, so the exported PNG's
  markers and the page's disagreed. *Gate:* `test:contrast` compares the
  exporter's constants against the tokens.
