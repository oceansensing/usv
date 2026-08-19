# @c4po/erddap-pmel

Reading uncrewed surface vehicle records off the NOAA PMEL ERDDAP
(`data.pmel.noaa.gov/pmel/erddap`, ERDDAP 2.30.0) — the only server it is
tested against, though the base URL is a parameter everywhere.

Everything below was **measured against the live server** on 2026-08-19, not
read out of the documentation, and three of the measurements contradict what
the obvious design would have assumed.

## This package cannot run in a browser

**PMEL sends no `Access-Control-Allow-Origin` header.** Not on a 200, not on
an error, not on an `OPTIONS` preflight. With `Origin: https://oceansensing.org`
set:

```
PMEL   200      → Content-Type, Content-Disposition, HSTS … and no ACAO
PMEL   OPTIONS  → Allow: GET, HEAD, POST, OPTIONS … and no ACAO
IOOS   200      → Access-Control-Allow-Origin: *
```

The sibling `@c4po/erddap` is built for the IOOS Glider DAC and is called
from the reader's browser. Nothing here can be. `fetchTable`, `fetchInfo`
and `listDatasets` run under Node at build time; the site reads the JSON
they were used to write.

The types are exported from here anyway, because the browser code consumes
them and two copies of `DatasetSummary` would drift.

## The economics of a request

**There is a strong server-side cache, and it dominates every other
effect.** A number taken once is not a measurement:

| | cold | warm |
|---|---|---|
| `sd1057_hurricane_2024`, 3 columns, 190,564 rows | **43.1 s** | **9.1 s** |
| `sd1041_hurricane_2024`, `orderByClosest("time/1hour")` | **61.4 s** | **12.9 s** |

Warm, on `sd1041_hurricane_2024` — 226 days, 324,843 rows, 77 columns:

| request | bytes | wall |
|---|---|---|
| 3 columns, full rate | 12.7 MB | 12.8 s |
| **all 77 columns, full rate** | **132.7 MB** | 17.9 s |
| 3 columns, `time/1hour` | 0.21 MB | 12.9 s |
| 19 columns, `time/20minutes` | 2.1 MB | 17.4 s |

And on `sd1030_hurricane_2026` — 30 days, 42,003 rows:

| request | bytes | wall |
|---|---|---|
| all 52 columns, full rate | 12.5 MB | 1.7 s |
| 6 columns, full rate | 2.7 MB | 1.0 s |

Three facts, and the third is the one that shaped the module:

1. **Columns are the dominant lever** — a factor of ten in bytes on the same
   rows. `fetchTable` takes an explicit list and there is no way to ask for
   `*`.
2. **`orderByClosest` saves bytes and not server time**: 12.9 s against
   12.8 s for sixty times fewer rows, because ERDDAP applies it after the
   read. It is a transfer-size mechanism. Reaching for it to make a slow
   request fast does nothing at all.
3. **Server time scales with the span scanned**, near enough linearly, cache
   aside.

### So there is no chunking, unlike the glider client

That client chunks by elapsed time because a reader is watching a blank page
and something has to appear inside a second. Nobody is watching a build. And
by (3), five requests covering a span cost what one covering it does plus
five scans' overhead — chunking a build is strictly worse. What replaces it
is a **retry**, because PMEL's cold responses reach a minute and occasionally
time out, and losing a dataset to one flaky request is the actual risk here.

## The ladder is a multiple of five minutes, and that is the whole design

A Saildrone's SBE37 reports every five minutes into a one-minute record.
**80.2 % of full-rate rows carry no sea temperature.** `orderByClosest`
returns the row nearest each interval boundary, so an interval that is a
multiple of the sensor's own period lands *on* the reporting rows, and one
that is not lands between them.

Measured on `sd1030_hurricane_2026`, the same five-day window:

| | full rate | `time/20minutes` |
|---|---|---|
| rows | 7,201 | 361 |
| `wind_speed_world_filtered` missing | 0.8 % | 0.8 % |
| **`sbe37_temperature_filtered` missing** | **80.2 %** | **0.8 %** |

Decimating made the sea-temperature record a hundred times *denser*, because
it stopped sampling the gaps. `LADDER` is therefore
`[1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360]` and every rung above 2
divides by 5. **A rung of 7 or 25 minutes would return a mostly-empty CTD
record**, the plot would show a dozen points where there are thousands, and
nothing anywhere would say why.

`chooseRung` also starts the ladder at the vehicle's own cadence rather than
at 1: asking a five-minute Oshen for one-minute rows returns nothing extra
and costs the same.

### The interval string

`orderByClosest("time/2hours")` and `orderByClosest("time/120minutes")` are
accepted and identical. `orderByClosest("2hours")` — without the column — is
a 400: the argument is a CSV list of order-by columns *plus* an interval, so
it needs at least two parts. `intervalString` writes hours above the hour
because the number must be an integer, and `1.5hours` is not one.

## One request at a time, and the server says so

A request that arrives while another from the same client is still running
**fails**, with a 408 whose body reads:

```
Request Timeout: TimeoutException: Timeout waiting for your other requests
to process. Please make just one request at a time.
```

Not a queue, not a slowdown — a refusal, after a two-minute wait. The first
full build ran three at a time and lost
`chanceMC29_NEFSC_nantucket_2026_fullres` to it on all three attempts, and
every manual request made while that build was running got the same 408.

The sibling glider client runs three concurrently against the IOOS DAC, and
carrying that number over here was the mistake. It buys nothing either way:
four parallel requests measured 4.3 s against ~4.4 s of serial time, so the
server serialises internally regardless, and the only thing the concurrency
added was failures. `build-series.mjs` uses a pool of **one**, and a 408 gets
a twenty-second backoff rather than the ordinary 1.5.

## Two API facts that break a client written from the documentation

- **An empty result is an HTTP 404**, body
  `message="Not Found: Your query produced no matching results."`. Not an
  empty 200. A gap in a record produces one, and a client that treats it as a
  transport failure reports the whole record as broken. `ErddapError.empty`
  marks it, and — unlike on the Glider DAC, where the error response carries
  no CORS header and a browser cannot read it at all — here it is legible,
  because this runs under Node.
- **`allDatasets` takes no paging parameters.** `page`/`itemsPerPage` belong
  to the HTML form and are a 400 here. It also carries a row for **itself**,
  which `parseCatalog` drops; left in, it becomes a vehicle at the null
  island with a 1970 start date.

## Times come in two forms, and the fast path must know both

```
2026-08-14T00:01:00Z        Oshen, Chance, older Saildrone   20 chars
2026-08-14T00:00:00.000Z    every 2026 Saildrone record      24 chars
```

`parseIsoTime` reads the digits by position for both. The glider client
checks only for length 20 and falls back to `Date.parse` otherwise — which
on *this* archive is the fast path missing on the largest datasets in it, at
324,843 rows apiece.

`jsonlCSV` is the wire format: one JSON array per line, **no header line**
on this server, missing values as `null`. An empty CSV field would have to be
*known* to mean missing rather than zero, and getting that wrong draws a line
through zero where a record has a gap.

## What the metadata does not have

**`ioos_category` is empty.** Across all 165 USV datasets only `Time` and
`Location` ever carry one. On the Glider DAC it is filled in for nearly
everything and is what separates a science variable from a flight-computer
readout — here it separates nothing, so `info.ts` classifies a column as
ancillary from its name, its type and a short list of identifier and flag
patterns, and `@c4po/usv-vars` does the rest.

**There are no QARTOD flags.** The 2026 hurricane fleet, every Oshen and
every Chance record publish no QC column at all. Ten older Saildrone
datasets carry `RH_QC`, `TEMP_AIR_QC`, `WND_QC`, `TEMP_CTD_QC` and a `_DM`
data mode, and that is the entire QC content of the archive. `@c4po/usv-qc`
exists because of this sentence.

**Eleven Chance datasets have no observations.** `cdm_data_type: Other` —
`EDDTableFromFileNames` listings of CTD casts, echosounder files, CPICS
imagery and raw ADCP, whose columns are `url`, `name`, `size`, `fileType`.
`kindOf` returns `files` for them and the site links rather than plots them.

## Classification is keyword-anchored, not a table

PMEL publishes no field saying which vendor built a vehicle or which mission
a record belongs to. Both are read out of the id, the title and the
institution, and `catalog.ts` is the only place that guessing happens.

The campaign is anchored on a keyword in the **title** rather than the id,
because the ids disagree with themselves across eras — the 2020 Bering
vehicles are bare `sd1043`, the 2021 ones `sd1055_swfsc_2021` — while the
titles have named the programme consistently since 2017. A table would have
to be edited every season, and its failure mode is a new mission silently not
appearing; `Hurricane Monitoring 2027` will classify itself.

The year comes from the **title** before the record's own `minTime`: a
deployment that ran into January belongs to the season it launched in, which
its name records and its start date does not.

## Fixtures

`scripts/fixtures/erddap/` holds real responses captured 2026-08-19:

| file | why this one |
|---|---|
| `catalog.json` | every USV row plus the `allDatasets` self-row |
| `info-sd1030_hurricane_2026.json` | 2026 Saildrone, 52 vars, lowercase `_filtered` era |
| `info-sd1005_2017.json` | 2017 Saildrone, 66 vars, the only era with `_QC`/`_DM` columns |
| `info-all_swfsc_2023.json` | a multi-vehicle collection, `SCREAMING_SNAKE` era |
| `info-oshenPD11_hurricane_2026.json` | Oshen 2026, 11 vars, RH declared `units = 1` |
| `info-oshenPC3_hurricane_2025.json` | Oshen 2025, the other Oshen naming era |
| `info-chanceMC29…_nrt.json` | Chance, 101 vars, several with no units at all |
| `info-chanceMC29…_ctd.json` | a file listing: `cdm_data_type: Other`, no observations |
| `rows-sd1030.jsonl` | `.000Z` times and the 5-minute SBE37 `null` interleave |
| `rows-oshenPD22.jsonl` | 2026-08-07, a day the pressure spike artifact was active |
