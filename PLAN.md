# Where this stands

A working record of what is built, what was decided and why, and what is
still open. `README.md` is for someone using the site; `CLAUDE.md` is for
someone changing it; this is for picking the work back up.

**Live at https://oceansensing.org/usv/** — GitHub Pages from `main`,
deployed by `.github/workflows/deploy.yml`. `npm run verify` gates the
deploy and runs entirely offline.

---

## The decision everything else follows from

**The PMEL ERDDAP sends no `Access-Control-Allow-Origin` header**, so a page
served from `oceansensing.org` cannot read it. Measured 2026-08-19 against
`data.pmel.noaa.gov/pmel/erddap` (ERDDAP 2.30.0), with an `Origin` header
set, on a 200 and on an `OPTIONS` preflight:

```
PMEL   200 → (no such header)      OPTIONS → Allow: GET, HEAD, POST, OPTIONS
IOOS   200 → Access-Control-Allow-Origin: *
```

The sibling glider site fetches the IOOS Glider DAC from the reader's
browser and draws what comes back. **That design does not transfer here.**
Every alternative was considered:

| | why not |
|---|---|
| fetch it anyway | the browser blocks the response before any code sees it |
| a public CORS proxy | an untrusted third party between the reader and NOAA |
| our own proxy | infrastructure this site otherwise does not need, and a live dependency for a page that need not have one |

So **the build fetches, and the browser reads what the build wrote.** The
data is baked into `public/data/` by `npm run data`, gitignored, regenerated
by CI, and served from this origin. What the site loses is live freshness,
which a schedule buys back. What it gains is a page that opens in
milliseconds rather than seconds, works with the ERDDAP down, and needs
`connect-src 'self'` and nothing more.

---

## What the data actually is

165 datasets on the PMEL ERDDAP mention Saildrone, Oshen or Chance Maritime.
Eleven are `EDDTableFromFileNames` file listings (`cdm_data_type: Other` —
CTD casts, echosounder, CPICS imagery, raw ADCP) and carry no observations;
they are offered as links, not plotted. **153 are plottable**, spanning
**14,717 vehicle-days**, median 91 days.

| vendor | datasets | era |
|---|---|---|
| Saildrone | 130 | 2017 – 2026, TPOS / Arctic / hurricane / fisheries / West Coast / ECMWF |
| Oshen | 21 | 2025 (PC series), 2026 (PD series) |
| Chance Maritime | 14 (3 plottable) | 2026, NEFSC Nantucket Shoals and Outer Shelf |

### Two things the glider site could rely on and this one cannot

**`ioos_category` is empty.** On the Glider DAC it is filled in for nearly
everything and is what separates a science variable from a flight-computer
readout. On PMEL only `Time` and `Location` carry it. Nothing can be
classified from it.

**There are no QARTOD flags.** The 2026 hurricane fleet, every Oshen and
every Chance dataset publish no QC column at all. Ten older Saildrone
datasets carry `RH_QC`/`TEMP_AIR_QC`/`WND_QC` and a `_DM` data mode, and
that is the entire QC content of the archive.

Which is why `packages/usv-qc` exists and is not a nice-to-have: **on this
archive, the only quality information a reader can get is the quality
information this site computes.**

### Four naming eras, one quantity

The same measurement is published under a different name in every era, and
Chance reuses Saildrone's middle-era convention:

| | air temperature | sea temperature | wind speed |
|---|---|---|---|
| Saildrone 2017 | `TEMP_AIR_MEAN` | `TEMP_CTD_MEAN` | `wind_speed` |
| Saildrone 2021–24 | `TEMP_AIR_MEAN` | `TEMP_SBE37_MEAN` | `WIND_SPEED_MEAN` |
| Saildrone 2026 | `air_temperature_filtered` | `sbe37_temperature_filtered` | `wind_speed_world_filtered` |
| Oshen | `air_temperature_mean` | `sst_mean` | `wind_speed_mean_motion_corrected` |
| Chance 2026 | `TEMP_AIR_FILTERED_MEAN` | `TEMP_SEA_FILTERED_MEAN` | `WIND_SPEED_PLATFORM_FILTERED_MEAN` |

304 distinct column names across the Saildrone datasets alone. `usv-vars`
maps them onto one canonical set, and a fleet comparison is only possible
because it does.

### No depth

These are surface vehicles. There is no section, no profile and no depth
axis anywhere on this site — the figures are **time series along a track**,
which is what the glider site does not have and most of what this one is.

---

## Built and shipped

### Five packages

| package | what it is |
|---|---|
| `packages/erddap-pmel` | the PMEL client. Node only — PMEL sends no CORS header |
| `packages/usv-vars` | **429 vendor column names onto 63 canonical quantities**, 97.9 % of dataset-columns resolved, plus units and the seven derived quantities |
| `packages/usv-qc` | the nine checks, because the archive publishes none |
| `packages/plot` | the SVG plot engine, vendored from `gliders` |
| `packages/teos10` | seawater properties, vendored from `gliders` |

### The data build

`npm run data` fetches the catalog and every record from PMEL, converts
units, derives U₁₀, wind stress, dewpoint, specific humidity and the TEOS-10
surface set, runs the QC at the fetched resolution, then decimates to 8,000
points and rounds each column to what its instrument resolves.

- **The cache is keyed on each record's last report time**, so a historic
  record is valid forever and an active mission invalidates itself. Nothing
  to expire, nothing to tune. CI restores it between runs, which is what
  makes a four-times-daily rebuild affordable.
- Cold, 153 records take about 40 minutes; warm, only the active missions
  move.
- **JSON of rounded numbers**, because it gzips *smaller than Float32
  binary* (315 KB against 356 KB on the largest record) and GitHub Pages
  compresses `application/json` while leaving `application/octet-stream`
  alone.

### Five pages

- **`/`** — the fleet. Every record on one map and in one searchable table,
  filterable by vendor, campaign, year, quality and whether it is reporting
  now. Tracks capped at 40 with the cap printed.
- **`/vehicle/?dataset=<id>`** — one deployment. The track coloured by any
  variable, a stack of up to six time series on one shared clock, a
  property–property scatter, and the quality report, with each finding able
  to open the variable it is about. Every choice is in the query string.
- **`/campaign/?id=<slug>`** — the cohort. One polyline per vehicle, a roster
  that is the map's legend, and **a Saildrone and an Oshen on one axis** —
  which is the whole point of the canonicalization layer.
- **`/qc/`** — what the nine checks look for, what each one is *not*, and
  every record they found something in.
- **`/about/`** — the sources, what was converted, what was computed here,
  and what the checks do not claim.

### The full-rate tier

`npm run data:detail -- --season 2026` writes weekly, pre-gzipped chunks plus
a `season.json` index into a directory a **shard repository** publishes as
its own Pages site — `oceansensing.org/usv-data-2026/`, the same origin as
the site, so no CORS and no CSP change.

A vehicle page opens on the overview and says how many full-rate samples
exist; narrowing to a stretch fetches the weeks it covers, about 380 KB each,
and every figure redraws at the rate the instruments reported. Verified in a
real browser on the live site: a three-day window on `sd1030_hurricane_2026`
goes from 720 drawn points to **4,319** — 3 × 1440 minutes — with 4,319
vertices actually in the SVG.

Then stress-tested, 2026-08-19, by reading the published shard back in full.
All 74 chunks, 12.85 M values: **0 structural failures** — every row in the
chunk its number claims, every count and length agreeing, and closed chunks
byte-identical across a rebuild, which is what a saved link rests on. All
three vendors work, not just the Saildrone it was built on. Both tiers agree
on which 24 records exist.

It found two things wrong, both about what the page does rather than what the
shard holds: a window had **no ceiling** — one drag on the archive's longest
record would have asked for 63 chunks and 26.5 MB — and full rate was offered
on 14 records that had nothing finer to give. Fixed in `86d8f5a`; both are in
`CLAUDE.md` §7. The shard itself needed no change, which is the result that
matters before it is replicated nine times.

### The gates

**792 offline checks** in eight suites, chained by `npm run verify`. Nothing
in it touches the network, so it cannot fail because PMEL is having a bad
morning — which is exactly when you least want the deploy blocked.

`check:vendored` reports drift against the sibling `gliders` repository and
does not fail the build, because that repository is not present in CI. It
earned its keep before it was finished: `tokens.css` had drifted and was
missing the three map-marker colours entirely.

### Deployment

`.github/workflows/deploy.yml`: verify → build (fetch + bake) → deploy, on
push and **four times a day**. The schedule is the opposite decision from the
sibling site's deliberate lack of one: that site renders nothing at build
time, so a rebuild publishes identical bytes; here the build *is* the data
path, so rebuilding is the only way the site gets fresher.

---

## Deliberately not done

- **No live fetch, and no proxy to enable one.** Above.
- **No analysis.** The sibling repository
  [NOAA-USV-analysis](https://github.com/truedichotomy/NOAA-USV-analysis)
  is where intercomparison, storm context and glider collocation live. This
  site shows what the vehicles measured and what is wrong with it; it does
  not draw conclusions from it.
- **No route per dataset.** 153 datasets and more every season is a query
  string, not 153 pages. Reader state — dataset, window, variables, colour
  scale — lives in the URL, so a view is a link.

---

## Open

- **`chanceMC29_NEFSC_nantucket_2026_fullres` still cannot be fetched.** One
  record of 153. Its 408 says the server is busy with another request from
  this client, which was true when the build ran three at a time and is not
  now — so something else is going on, and a narrower query did not help
  either. It costs a bounded fifteen minutes of each build (three attempts at
  the five-minute timeout) and the site says so on its page and links to the
  ERDDAP. A chunked fetch is the obvious next thing to try.
- **The QC resolution ladder** means a multi-year record is checked at 5 min
  rather than 1 min; a one-minute spike in a 2021 record is not looked for.
  Stated on every page rather than hidden, but a second pass at native rate
  for the long archive records is worth doing if the build budget allows.
- **Chance Maritime's `_ctd` and `_echosounder` file listings** hold real
  profile data behind per-cast files. Reading them would give this site its
  only vertical structure — and the only figures on it with a depth axis.
- **The comparison figure has no per-vehicle legend beyond the roster.** A
  colour bar labelled 0–1 is honest and not friendly; a categorical legend
  drawn from the roster would be better.
- **A multi-vehicle record's *series* is still interleaved.** Thirteen
  records carry several vehicles in one table. Their tracks are no longer
  drawn — the map shows the area worked instead — but the time series still
  step between vehicles row by row, which for `all_swfsc_2023` means a
  temperature trace that jumps between three Saildrones. Splitting them needs
  the `trajectory` column, which the parser turns to NaN because it is a
  string; ERDDAP's `distinct()` would give the values in one small request
  per record. Worth doing: `saildrone_arctic_2018` is the only record of the
  2018 Arctic met and ocean data, and it is one of the thirteen.
- **Only 2026 is sharded.** The other nine seasons need their repositories
  created and built — the same command with a different `--season`, which is
  the point of doing one first. The shard is now stress-tested and in final
  form, so this is the next job; `NEXT.md` carries it, with the per-season
  sizes and what to watch for.
- **The QC still runs on the overview's resolution**, not the full-rate tier.
  Measured, this bites less than it looked: the QC runs *before* the
  decimation, so every 2026 Saildrone and Chance record is already checked at
  native rate. It becomes real for 2021 and 2024, whose long records are
  checked at 5 minutes and where a one-minute spike is not looked for.
- **`orderByClosest` alignment is assumed to hold for every sensor.** It was
  measured on the Saildrone SBE37 at five minutes. A sensor reporting on some
  other period — three minutes, say — would be sampled between its rows by
  every rung on the ladder, and nothing would say so. A build-time check
  comparing each column's missing fraction before and after decimation would
  catch it.
