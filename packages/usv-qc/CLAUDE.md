# @c4po/usv-qc

The quality information this archive does not publish.

The 2026 hurricane fleet, **every** Oshen and **every** Chance record carry
no QC column at all. Ten older Saildrone datasets carry `RH_QC`,
`TEMP_AIR_QC`, `WND_QC`, `TEMP_CTD_QC` and a `_DM` data mode, and that is the
entire QC content of 153 records. So every quality statement on this site is
one this package made, and every page it appears on says so.

## The one rule

**A finding marks the data. It never removes or alters it.**

No check writes to a series. A spike that has been found is still drawn,
still exported and still counted — drawn with a mark beside it saying what
was noticed. Silently deleting somebody else's observations on the strength
of a heuristic written here would be the worst thing this package could do.

## Thresholds are two-part, and both parts are load-bearing

Every threshold is `max(k × robustScale, floorForTheQuantity)`.

A purely **relative** threshold fires constantly on a quiet record: a
one-minute barometric record has a robust σ of **0.045 hPa** between samples
(measured on `oshenPD22`), so six of those is 0.27 hPa, which is weather.

A purely **absolute** threshold cannot serve a Caribbean August and an Arctic
October from one table.

The scale is the **MAD**, not the standard deviation, and that is not
fastidiousness: σ is computed *from* the outliers being looked for, so a
record with a ±34 hPa artifact reports a σ large enough to hide it.
`test:qc` plants spikes into a clean series and asserts σ moves by 20× while
the robust scale moves by under 15 %.

## The checks

| check | what it is, and what it is not |
|---|---|
| `gap` | the vehicle or its link stopped. Measured against the record's **own** cadence, so ten minutes of silence is a fault on a 1-minute Saildrone and normal on a 5-minute Oshen |
| `spike` | a step out and an **immediate step back**. A step that stays is weather |
| `stuck` | one value repeated for hours. Measured in **elapsed time**, not samples |
| `range` | outside what the quantity can physically be — not outside what is usual |
| `dropout` | a sensor missing where the vehicle is not. Dead and intermittent reported separately |
| `cadence` | the reporting interval changed part-way through |
| `timeorder` | the clock runs **backwards** between consecutive rows |
| `position` | missing fixes, the null island, and jumps no USV could make |
| `metadata` | units missing, damaged, or contradicted by the values |
| `silent` | the record has stopped growing |

### `gap` and `dropout` are the distinction that makes the report useful

A gap is the vehicle; a dropout is a sensor. PD23 in August 2026 is the case
that made this concrete: 24 interruptions of 35–79 minutes, **normal values
whenever it did report**, and a continuous track — a link problem, not a
sensor one. A report that called both "missing data" would have sent someone
to look at the wrong thing.

### `spike` is a shape, not a magnitude

Nothing physical at these scales moves and returns within one sampling
interval. So a 17 hPa step that *stays* is a front and is unmarked, and a
17 hPa step reversed by the next sample is a telemetry frame. `test:qc`
asserts both.

**Validated against a record it did not produce.** `oshenPD22`, 2026-08-07 —
the day the Aug-4 cohort's pressure artifact was active. The campaign
analysis (`truedichotomy/NOAA-USV-analysis`, `src/oshen_qc.jl`)
characterised it independently as single-sample spikes quantized at
±8.5/±17/±34 hPa. This detector, run on the raw fixture, finds **21 events
that day, up to 17.7 hPa**, with the same day's sea temperature, wind and
row cadence all clean. Agreeing with a conclusion reached elsewhere is the
only real check a heuristic like this can have.

### `stuck` measures time because these instruments quantize

An Oshen publishes sea temperature to **0.05 °C** and humidity to **1 %**. A
calm night legitimately repeats a value for many consecutive samples, and a
test written as "identical consecutive values" reports every Oshen in the
fleet as broken. The run has to be long in **hours**.

### `range` is wide on purpose

These are "not a measurement of this", not "unusual". **880 hPa is a
category-5 core** — the whole point of this fleet is to be in one, and a
range that reported it would be worse than useless. What it catches is an
undecoded `-999` sentinel and a unit that was never converted, and it says
which it thinks it is from the fraction of the record affected.

### Circular quantities are excluded, visibly

**A bearing crossing north steps by 359° and back**, which is exactly the
shape `spikes` looks for. Nothing here understands circular quantities, so
rather than pretend, `report.ts` skips them and the exclusion is a named set
you can read. `stuck` is skipped for the same reason plus another: a vehicle
at station legitimately holds a heading.

`RESTS_AT_ZERO` skips `stuck` on the radiometers and PAR, which read exactly
zero all night, every night. That is the instrument working.

### Sparse is not missing

A Saildrone's SBE37 reports every five minutes into a one-minute record —
**80 % of rows empty and a perfectly healthy instrument**. `dropout` counts
rows, so `report.ts` only accepts its intermittent verdict when the column's
own `reportingInterval` is close to the vehicle's cadence. The *trailing
window* test still fires regardless, because a sparse sensor that dies is
still dead.

### Dead needs the whole trailing window

90 % of the final twelve hours missing, which is the rule `oshen_qc.jl` uses.
A window a third full is genuinely ambiguous and falls through to
"intermittent" — which is the honest answer, not a weaker one.

## A false positive costs more than a miss

Every one pushes a real finding off the page, and a quality report nobody
trusts is worse than no quality report. So **half of `test:qc` asserts that a
check stays quiet**: on a quantized Oshen record, on a real front, on a slow
barometric fall, on a category-5 pressure, on a healthy five-minute CTD in a
one-minute record.

One of those quiet cases looks like a miss and is not, so it is asserted
explicitly: **when a third of the samples are excursions, none is reported.**
The relative half of the threshold does that on its own — the step
distribution *is* ±20 hPa, six robust sigmas of it is 120, and nothing
clears it. A signal behaving that way is the instrument's normal output, or
the record is corrupt enough that marking individual samples is beside the
point.

## The report states what it could not have seen

`coverageNote` prints the resolution the checks ran at against the vehicle's
own cadence. The long archive records are checked at five minutes; **a
one-minute spike in a 2021 record was never looked for**, and a report that
does not say so implies it looked at everything.

## Marks are capped; counts are not

A record with thousands of spikes gets a `count` that is exact and a `marks`
array of at most `MAX_MARKS` (500) spread evenly, keeping both ends. The
alternative is a JSON file larger than the data it annotates.

`rank()` is a **stable** total order — severity, then time, then check, then
column. The report is written to a file that is diffed between builds, and an
unstable sort would show every dataset as changed every night.

### `timeorder` exists because the map was already reacting to it

Nothing looked at the order of the clock. `cadence` averages over 500-row
windows and discards any interval that is not positive, so a shuffled record
reads to it as perfectly regular — and **24 single-vehicle records in the
archive step backwards**, `sd1034_ecmwf_ags_2021` by 1,016 of its 123,360
rows. Meanwhile `reachable` on the site lifts the map's pen at every one of
those steps. A quality report silent about the thing the map is visibly
reacting to is the site contradicting itself on two screens.

It is about **order, not values**: a mean, a range and a histogram do not care
what order they were handed. A track, a difference, a rate and a spectrum do.

Not run on a record that interleaves several vehicles, where backwards is the
shape of the table — eleven records — and where the page already says so.
