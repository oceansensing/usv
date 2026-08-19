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

### One request at a time, and the server says so in as many words

A request that arrives while another from the same client is still running
does not queue — it waits about two minutes and then **fails**:

```
408  Request Timeout: TimeoutException: Timeout waiting for your other
     requests to process. Please make just one request at a time.
```

The sibling glider client runs three concurrently against the IOOS DAC, and
carrying that number over was the mistake. The first full build ran three at
a time and lost `chanceMC29_NEFSC_nantucket_2026_fullres` on all three
attempts; every manual request made while that build was running got the same
408, which is how it was found.

It buys nothing either way — four parallel requests measured 4.3 s against
~4.4 s of serial time, so the server serialises internally regardless. The
only thing the concurrency added was failures. `build-series.mjs` uses a pool
of **one**, and a 408 gets a twenty-second backoff rather than the ordinary
1.5.

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

### Two tiers, and why the second lives in another repository

The overview is 8,000 points however long the mission — one small file the
vehicle page opens with. **The full-rate tier is every sample the instruments
reported**, in weekly chunks, fetched only for the stretch a reader has
windowed into.

It cannot sit beside the site. Measured on a real month of 1-minute data —
44,401 rows × 41 columns — the archive at full rate is **3.96 GB as plain
JSON and 794 MB gzipped**, against GitHub Pages' **1 GB published-site
limit**, which the documentation applies with no distinction for repository
visibility or plan.

| | stored | transferred |
|---|---|---|
| plain files, Pages gzips | 3.96 GB ✗ | 0.79 GB |
| **pre-gzipped, browser inflates** | **0.79 GB ✓** | 0.79 GB |
| int16 delta-coded binary | 0.69 GB | 0.69 GB |

So the chunks are stored **already compressed** and inflated in the tab with
`DecompressionStream` — the same mechanism, and the same reason, as the
sibling glider site's TEOS-10 atlas. Verified against the live host: a `.gz`
comes back byte-identical under `content-type: application/gzip`.

A binary format buys only **13 %** gzipped at this resolution and costs a
decode step and readability, so JSON stays.

**One repository per season**, each a Pages project site. `gliders` and `usv`
already prove the arrangement: project repositories under an organisation
whose Pages custom domain is set serve *under that domain*, so
`oceansensing/usv-data-2026` serves at `oceansensing.org/usv-data-2026/` —
**the same origin as the site**. The whole tier therefore costs no CORS and
no widening of `connect-src 'self'`.

Per season because **a closed season is immutable**: once 2024 ended its data
cannot change, so its shard is built once and never rebuilt or re-uploaded,
and only the current season churns. The busiest season on record is 2021 at
194 MB — five times under the limit — so `shardFor` gaining a vendor term is
the change to make when a season needs it and not before. It is one function
so that change is local.

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

### What the first shard actually measured

`usv-data-2026` was built, published, and then read back in full — all 74
chunks, 2026-08-19. The design above survived it; these are the numbers it
replaced estimates with.

| | |
|---|---|
| the season, one month in | 24 records, 413,498 rows, 74 chunks, **15.66 MB** |
| the encoding | 12.85 M values → **1.28 B/value gzipped** |
| a chunk, inflated in the tab | 9,421 rows × 29 columns in **143 ms** |
| how it is served | `application/gzip`, `content-encoding` absent |

Then `usv-data-2021` — the archive's *largest* season — was built and read
back the same way, which is what the 2026 figures needed:

| | 2026 | 2021 |
|---|---|---|
| what it is | short Oshen runs, many small files | long Saildrone runs |
| records / chunks | 24 / 74 | 21 / **437** |
| rows | 413,498 | **4,411,931** |
| **gzipped** | 15.66 MB at **1.28 B/value** | 118.38 MB at **0.77 B/value** |

**The two encodings differ by 40 %, and 0.77 is the one to plan with** — every
large season is long Saildrone records, and 1.28 was pessimism from a season
unlike the rest. It puts the whole archive near **0.5 GB**, against the
earlier 794 MB projection taken from a single month before any shard existed.
The largest season is now measured rather than estimated, at 118 MB — five
times under a limit that applies per repository anyway.

Estimating from the catalog reproduces the aggregate to about 1.2×, and is
*not* reliable per record: on the Oshens it ranges 0.31× to 2.14×, because
their cadence changes mid-mission and `span / cadence` is then a bad count of
rows. Both conclusions the sharding rests on hold with more room than they
were given.

**Closed chunks come back byte-identical across rebuilds**, checked by
refetching four of sd1030's after a rebuild had moved the fifth. That is the
contract a saved link depends on, and it holds because a chunk number is
`floor(t / 604800)` — a fact about the timestamp, not about the record — so
a record that gains data gains chunks and never renumbers the ones it had.

### A window needs a ceiling, because selecting one is a single gesture

A reader windows by dragging across a figure, so **selecting a whole mission
costs exactly as much effort as selecting an hour** and nothing in the
gesture says how long the mission is. Measured, the whole of
`chanceMC40_NEFSC_outershelf_2026_nrt` is five weeks, 2.8 MB, 170 ms — fine.
But 2026 is the *shortest* season in the archive:

| record | weeks | uncapped cost of one drag |
|---|---|---|
| `chanceMC40_…_2026_nrt` | 5 | 2.8 MB — measured |
| `sd1041_hurricane_2024` | 33 | 14.3 MB, 33 parallel requests |
| **`sd1065_tpos_2021`** | **63** | **26.5 MB, 63 parallel requests** |

`MAX_WINDOW_CHUNKS` is **8** — twice the largest window measured here, about
5 MB at Saildrone rates. Past it the reader has selected a season rather than
an event, the overview is the instrument for that, and the page says so
instead of spending the connection on samples no screen resolves.

### Full rate is only offered where it is finer

A record short enough to escape the 8,000-point budget is drawn whole, so its
shard holds exactly the samples already on screen. That is **14 of the 2026
shard's 24 records**, every Oshen among them — and on several the shard holds
*fewer* rows than the overview, the two tiers having been fetched minutes
apart. So the page compares the two counts before it offers anything, and
where there is no finer view it says so and asks for no chunk at all.

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

### The pen lifts where the vehicle could not have sailed

A polyline through every fix draws a straight line across whatever lies
between two consecutive ones, and on this archive that is sometimes a
continent. **Three 2024 Saildrones were recovered in the Atlantic and their
records continue with dock telemetry from Alameda**: the last segment of
`sd1042_hurricane_2024` runs **4,055 km from off Cape Hatteras to 37.8 °N
122.3 °W — San Francisco Bay — over twenty days**, and joined up it crosses
the United States. The vehicle was on a ship, and nothing in the file says
so.

`lib/reachable.ts` asks whether the vehicle *could have got there*, and there
are three ways the answer is no:

| | why |
|---|---|
| **too fast** | over 8 m/s, the same limit the position check uses |
| **too long a silence** | over 6× the drawn spacing — `sd1040_hurricane_2024` covers 947 km in 86 days, which is 0.13 m/s and perfectly sailable, but nothing was observed between |
| **backwards** | three Oshen records step back in time between consecutive rows |

The second is the one a speed test alone misses, and it is the one that
catches Alameda: 4,055 km over 20 days is **2.3 m/s**, well inside what a
Saildrone does.

The cut is a *drawing* decision and touches nothing else — every fix is still
a point, still in the data, still exported. The tooltip says how many breaks
a track has. Both maps use the one rule, because a leap the quality report
calls impossible and the map drew anyway would be the site contradicting
itself on one screen.

Half of `test:track` asserts that an **ordinary** track is left alone: a rule
that cuts a real transit into pieces is worse than the line it prevents,
because a broken track reads as missing data.

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
| `test:build` | that a fix to a derived file reaches the records that stopped reporting |
| `test:erddap` | query construction, the CSV parse, 404-means-empty, the ladder |
| `test:vars` | that every naming era resolves to the same canonical variable |
| `test:qc` | each check against a record whose faults are known |
| `test:derive` | U10, wind stress, humidity and the TEOS-10 surface set |
| `test:track` | where a track is cut, and that an ordinary transit is not |
| `test:plot` | windows vs rescaling, reported decimation, robust limits, colormap names |
| `test:contrast` | every colour pair that ships |
| `test:pages` | the base path, the CSP, and every CSS rule jsdom cannot see |

`npm run verify` chains build, type-check, the doc gate and all nine.
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
- **Concurrency three, copied from the sibling client, cost a dataset.**
  Above, in §2. It is the clearest case on this site of a number that was
  right for one server being wrong for another, and the only reason it was
  found is that a manual request during a build got the same error.
- **A severity that fired on 76 % of records.** The first full build put a
  high-severity badge on 115 of 152. Two causes, the same mistake twice:
  treating a fact about the archive as a fault in the data. A column declared
  and never filled is an instrument that was not fitted, and a sensor that
  stopped at the end of a record that ended eight months ago is a mission
  being packed up. Both are worth reporting; neither is "unusable where it
  fires".
- **The fleet map drew tracks across North America.** Reported by a reader
  looking at the live site, which is the only way it was ever going to be
  found: the line is plausible unless you notice it crosses land. The
  comment above the offending loop already said "joining across the gap
  draws a line the vehicle did not sail" — and the code skipped the missing
  fix and joined its neighbours, which is exactly that. The comment
  described the intent and the code did the opposite.
- **The site's own `tokens.css` had drifted from the sibling's** and was
  missing the three map-marker colours entirely, so the exported PNG's
  markers and the page's disagreed. *Gate:* `test:contrast` compares the
  exporter's constants against the tokens.
- **The detail tier was offered where it held nothing extra.** A record under
  the 8,000-point budget is drawn whole, so its shard is the same samples
  again — 14 of the 2026 shard's 24, and on several the shard has *fewer*
  rows than the overview. The page said "5,739 samples at full rate are
  available: narrow to a stretch" to a reader already looking at all 5,739.
  It compares before it promises now. *Gate:* the comparison is on the page's
  own numbers, so no fixture can go stale under it.
- **One drag could have asked for 26.5 MB.** A window is a drag across a
  figure, and the cost of that gesture is the length of the mission, which
  the gesture does not mention. Nothing capped it. It never bit, because the
  only sharded season is the archive's shortest — 2026's longest record is
  five weeks. `sd1065_tpos_2021` is 63. *Gate:* `test:vars` asserts the cap
  sits above the largest window measured here and below that record.
- **Two fallbacks announced the overview without returning to it.** A window
  covering no chunk, and a chunk that 404s, both left the previous window's
  full-rate columns in `detailSource` while the note said the overview was
  shown. Neither is reachable by dragging — a reader cannot select a stretch
  the figure is not drawing — which is exactly why they survived a first
  reading. A shared link carrying a stale window reaches both.
- **A shard's `cadenceSeconds` describes a record that has only one cadence.**
  It is the median over the whole record, and 11 of the 15 Oshen chunks
  disagree with their own record's figure — `oshenPD19` is published as 120 s
  and its last week runs at 600. Nothing reads the field, so nothing is
  wrong on screen; it is recorded here because the next thing to read it will
  believe it.
- **The note that says what the checks could have seen said the opposite, on
  46 records.** `coverageNote` compares the resolution the fetch ran at
  against the vehicle's reporting interval — and it was handed, as that
  interval, the spacing of the rows it had just been given. On a decimated
  fetch those are the same number *by construction*, so the branch that warns
  "a single-sample artifact finer than that was not looked for" **could never
  fire**. Every record fetched at 2 or 5 minutes against a vehicle reporting
  every minute — 46 of 152, most of 2017–2024 — told the reader its
  one-minute artifacts had been looked for. The one sentence whose whole job
  is to stop the page implying it checked more than it did was implying
  exactly that. Found by reading the live 2021 shard: the page said `sd1065`
  ran at native rate while its own series file recorded `resolutionSeconds:
  300` beside `cadenceSeconds: 60`. *Gate:* `test:qc` now covers
  `coverageNote`, which nothing had — it is reached only through `run()`, and
  the suite tests the individual checks.
- **"against a vehicle reporting every 1 minutes."** Rounding an interval to
  whole minutes, on an archive whose commonest cadence is one minute. Only
  ever visible on the branch that could not fire.
- **The fix landed, the build went green, and the data did not change.**
  `coverageNote` was corrected on 46 records; the site rebuilt and deployed
  successfully; all 46 came back with the old sentence. The build cache is
  keyed on the record and its last report time — correct for the *data*, which
  is immutable once a mission ends, and wrong for the *file*, which holds
  findings, canonical names, derived quantities, rounding and the sentences
  the page prints. **An archived record's `maxTime` never moves again, so the
  old file is served forever.** Every one of the 46 was a vehicle that had
  stopped reporting, which is exactly the population the fix was for. The key
  now carries a format version, `Cache` refuses to be built without one, and
  the note beside it says the ritual: change what an entry contains, bump the
  version. *Gate:* `test:build`, a suite that exists for this one thing.
- **Versioning the cache key broke the build at 0 of 153.** The info cache is
  written by `build-catalog` and read by the other two builds — and its
  filename was constructed in *three* places: a `Cache` in the writer, and an
  identical hand-rolled `infoCachePath` copied into each reader. Putting a
  version in `Cache.path` moved the writer and left both readers looking for
  the old name, so every record failed with `ENOENT` and the build stopped.
  It failed loudly and deployed nothing, which is the one thing that went
  right: `Nothing was built. Not deploying this.` The path and the stamp are
  each one function now. *Gate:* `test:build` asserts no build script contains
  a literal `.cache/info` or spells the stamp out for itself — which found two
  further copies of the stamp beyond the two that broke.
