# @c4po/usv-vars

One name for each thing a USV measures.

**429 distinct plottable column names**, across three vendors and four naming
eras, over 153 datasets and nine years. They reduce to **63 canonical
quantities**, and 97.9 % of dataset-columns resolve. Nothing above this
package sees a vendor's spelling, which is the only reason a Saildrone and an
Oshen can share an axis.

The counts are measured against the whole archive, not estimated.

## The four eras

| | air T | sea T | wind speed | gust |
|---|---|---|---|---|
| Saildrone 2017 | `TEMP_AIR_MEAN` | `TEMP_CTD_MEAN` | `wind_speed` | `GUST_WND_MEAN` |
| Saildrone 2021–24 | `TEMP_AIR_MEAN` | `TEMP_SBE37_MEAN` | `WIND_SPEED_MEAN` | `GUST_WND_MEAN` |
| Saildrone 2026 | `air_temperature_filtered` | `sbe37_temperature_filtered` | `wind_speed_world_filtered` | `wind_gust_filtered` |
| Oshen 2025 | `air_temperature_mean` | `sea_surface_temperature_mean` | `wind_speed_mean` | `wind_speed_of_gust` |
| Oshen 2026 | `air_temperature_mean` | `sst_mean` | `wind_speed_mean_motion_corrected` | `wind_speed_max_motion_corrected` |
| Chance 2026 | `TEMP_AIR_FILTERED_MEAN` | `TEMP_SEA_FILTERED_MEAN` | `WIND_SPEED_PLATFORM_FILTERED_MEAN` | — |

Chance reuses Saildrone's middle-era convention, which is the one thing in
this table that makes it smaller than it looks.

## Three things are parsed off a name, not enumerated

**The statistic.** `TEMP_AIR_MEAN` and `TEMP_AIR_STDDEV` are one quantity
reported two ways, and `standard_name` says `air_temperature` for both.
Enumerating every product of quantity and statistic would be four hundred
entries; `splitStatistic` is one function.

**The averaging word.** `_FILTERED_` is Saildrone's and Chance's word for
what `_MEAN` means. Dropped *after* the statistic, so `_FILTERED_STDDEV`
keeps its stddev.

**The sensor.** `TEMP_SBE37_MEAN`, `TEMP_CTD_RBR_MEAN`,
`TEMP_DEPTH_HALFMETER_MEAN` and `TEMP_O2_RBR_MEAN` all carry
`standard_name: sea_water_temperature`, and the last is the thermistor inside
an oxygen optode.

## `\b` is the wrong word boundary here, and it fails silently

An underscore **is** a word character, so `/\bsbe37\b/` does not match inside
`TEMP_SBE37_MEAN` — there is no boundary between `_` and `S`. The first draft
used it. Every Saildrone CTD came back with no sensor at all, the ranking
below fell through to a tie on the default rank, and a **stable sort happened
to return the right answer** because the dataset listed the SBE37 first. It
would have stopped doing that the first time a record listed its columns in
another order, and nothing on screen would have looked wrong.

`token()` builds `(?:^|[^a-z0-9])word(?:[^a-z0-9]|$)` instead, and
`test:vars` now asserts each sensor is *recognised* rather than only that the
ranking comes out right — because the ranking cannot be trusted to fail when
the recognition does.

## Which one is *the* sea temperature

The primary is the `mean` statistic on the highest-ranked sensor, and the
ranking is the instruments' own: a pumped SBE37 is the reference CTD, an RBR
beside it is a check, a half-metre thermistor is a different depth, and a
thermistor inside another instrument's housing is not a sea temperature
measurement at all. `HOUSEKEEPING` puts `TEMP_O2_*` last unconditionally.

**Labels are settled over the whole set, not per column.** A 2021-era record
carries `TEMP_CTD_RBR_MEAN` *and* `TEMP_O2_RBR_MEAN` — two instruments, both
RBR — so naming by sensor alone produces two menu entries reading "Sea water
temperature (RBR)". That is the same failure as two bare "Temperature" chips,
one step further along, and only a pass that can see both catches it. The
collision falls back to the column name, which is the one thing about a
column that is unique and that the file itself chose.

## A `standard_name` never outranks a name this file knows

Because the metadata is not always right. **`TEMP_LW_MEAN` is the longwave
radiometer's own body temperature and is published as `standard_name:
air_temperature`.** Counted as canonical it appears beside the real air
temperature under the same label, several degrees off, with nothing to say
which is the atmosphere. It is in `NEVER`, by name, with the reason attached
— and the reason travels to the page as a finding rather than being silently
dropped.

Kept as a named exclusion rather than a pattern: it is one column, the reason
is specific to it, and a pattern broad enough to catch it would catch things
that are fine.

## Units

Fifty distinct strings for about twenty actual units. Most of the variation
is spelling. Three cases are not:

- **Oshen wind is in knots** and everything else is m/s. Unconverted on one
  axis, an Oshen looks like it is in twice the wind of the Saildrone beside
  it. Converted at 0.514444 exactly.
- **Oshen relative humidity declares `units = 1` and publishes percent** —
  82.0, quantized to 1 %. Read at face value that is 8,200 % humidity. There
  is nothing to multiply by; the declaration is simply wrong. `usv-qc`
  reports it and this file does not "fix" it.
- **Chance publishes no units at all** on pressure, chlorophyll and the wind
  components. The quantity says what they must be, that is an inference, and
  it is recorded as a fault. **No conversion is invented** — guessing a scale
  is a different and much worse thing than guessing a label.

**A conversion is applied and stated, never applied silently.** Every
resolved column keeps `publishedUnits` alongside the conversion, so the page
can say what it did.

### The mojibake

`TEMP_LW_MEAN` on the two LWR datasets carries `¡C` — U+00A1, which is the
degree sign in **Mac Roman**, read back as Latin-1. `unitFault` detects it as
"a non-ASCII character that is not one a unit legitimately contains", rather
than by listing damaged forms: which mojibake a wrong codec produces depends
on the codec, while the legitimate set (`°µ²³⁻¹·−ÅΩ‰`) is short and closed.
Written the other way round — matching the damage — is how `m s-1` ends up
flagged for its hyphen, which the first draft did.

## Colormaps: five of them did not exist

`sample()` falls back to viridis for a name it does not know rather than
throwing. The first draft of `quantity.ts` named `cmo.phase`, `cmo.amp`,
`cmo.tempo`, `cmo.oxy` and `cmo.topo`; **only eleven cmocean maps ship in
`@c4po/plot`, and none of those five is among them.** Every affected quantity
would have drawn a perfectly good plot in entirely the wrong colours, with
nothing anywhere saying so. `test:vars` now checks every name against the
shipped table.

**A direction takes `hsv`**, and that is not decoration: a bearing wraps, so
359° and 1° have to come out nearly the same colour. Every sequential map
puts them at opposite ends of the ramp and draws a discontinuity across due
north that is not in the data.

## Derived: sea pressure is zero, and it is a constant

Every variable named `pressure` on a USV is **atmospheric**. There is no
depth axis in this archive outside three ADCP datasets, so the TEOS-10
quantities are evaluated at **0 dbar** as a named constant, never read from a
column.

The trap is silent. Measured on a real tropical sample (SA 36.86 g/kg,
29.56 °C), feeding `baro_pressure_filtered` ≈ 1013 to a seawater routine as
dbar gives:

| | error |
|---|---|
| in-situ density | **+4.28 kg/m³** |
| sound speed | **+16.7 m/s** |
| σ₀ | +0.085 kg/m³ |

σ₀ is the dangerous one: it is referenced to the surface and so barely moves,
which means the mistake survives a sanity check while still being eighty-five
times the precision density is quoted to.

## The wind profile is what makes two vendors comparable

`u10Neutral` adjusts to 10 m through a neutral log profile from the sensor's
own height — 0.66 m on an Oshen, ~3.4 m on a Saildrone, published per record
because the wing moves. **The Oshen adjustment is +31 %**, and without it the
vehicle closer to the water simply looks becalmed beside the one that is not.

Neutral is an assumption, not a measurement: the real profile depends on the
air–sea temperature difference. It is the standard first-order adjustment and
the page says it is one.

A height at or below the roughness length (z₀ = 9.665 × 10⁻⁵ m) returns NaN.
`log(z/z₀)` goes to zero there and negative below it, so the adjustment
explodes and then changes sign — and neither of those is a wind.

## The meteorological convention

A "northerly" is wind *from* the north, which moves air southward, so
`windComponents` returns **both components negated**. Getting it wrong flips
every vector by 180° while the wind rose still looks perfectly plausible.
`test:derive` round-trips nine bearings through both directions of the
conversion.
