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

*(sections filled in as each lands; see `CLAUDE.md` for how each works.)*

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

- The QC resolution ladder means a multi-year record is checked at 5 min
  rather than 1 min; a 1-minute spike in a 2021 record is not looked for.
  Stated on the page rather than hidden, but a second pass at native rate
  for the archive is worth doing if the build budget allows.
- Chance Maritime's `_ctd` and `_echosounder` file listings hold real
  profile data behind per-cast files. Reading them would give this site its
  only vertical structure.
