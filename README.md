# USV

Tracks, time series and quality control for every Saildrone, Oshen and
Chance Maritime uncrewed surface vehicle published on the
[NOAA PMEL ERDDAP](https://data.pmel.noaa.gov/pmel/erddap/info/index.html) —
153 deployments, 2017 to now, active and historic.

**https://oceansensing.org/usv/**

A static site. There is no server and no database: the observations are
fetched from PMEL when the site is built, checked, and written out as plain
JSON that your browser reads from this origin. Opening a vehicle is one
request for one file — and narrowing to a stretch of a mission fetches that
stretch at **the rate the instruments actually reported**, one minute on most
of the fleet.

## What it shows

### Every deployment, on one map

All 153 records back to 2017, searchable by vehicle, campaign or
institution, and filterable by vendor, year and what the quality checks
found. The map draws each mission's **actual track**, coloured by the company
that built the vehicle, with a dot at each one's last known position — filled
where it is still reporting. Click any track to open it.

### One deployment

- **The track**, coloured by any variable the vehicle carries, with your own
  colour scale and range.
- **Stacked time series** of everything it measured — wind, pressure, air
  and sea temperature, humidity, salinity, oxygen, chlorophyll, waves — on
  one shared time axis, so a pressure fall and a wind rise line up.
- **A property–property scatter**, any variable against any other, coloured
  by a third: T–S for the surface water mass, wind against pressure for a
  storm.
- **The quality report** — every issue found in that record, on the figure
  and in a table.

Narrowing to a stretch reloads every figure at **full resolution**. The page
opens on an overview of eight thousand points however long the mission, says
how many full-rate samples exist, and fetches only the weeks you have
windowed into — about 380 KB each. A three-day window on a Saildrone is 4,320
samples where the overview had 720.

Narrow any figure to a stretch of the mission with its own range boxes. The
variables on screen, the track's colour, its scale and its range all live in
the query string, so every view is a link.

### A campaign

The vehicles that flew together, on one map and one axis: the 2026 hurricane
fleet's nine Saildrones and thirteen Oshens, the Nantucket Shoals survey, a
TPOS season. Only the quantities the whole cohort carries are offered, and
each one was resolved from its vendor's own column name and converted to a
common unit first — **which is the only reason a Saildrone and an Oshen can
share an axis at all**. Without it one is in m/s at 3.4 m and the other in
knots at 0.66 m, and they look like different weather.

### What is wrong with the data

The PMEL archive publishes **no QC flags** on the 2026 fleet, on any Oshen
and on any Chance record, so every quality statement on this site is
computed here and says so. Nine checks run over each record when the site is
built — gaps, spikes, stuck sensors, impossible values, dead sensors,
position dropouts, cadence changes, metadata faults and cohort outliers —
and the findings are ranked fleet-wide on the
[quality page](https://oceansensing.org/usv/qc/) and drawn on the figure they
belong to.

Nothing is ever silently altered. A finding marks the data; it does not
remove it.

### Taking figures away

Every figure and the map export a **publication-quality PNG** — 3×
resolution, title and caption drawn in, boxed, on white, and for the map the
colour bar and basemap attribution too. Every dataset links to its own
ERDDAP page for the full-resolution numbers.

## Running it

```bash
npm install
```

```bash
npm run data
```

Fetches the catalog and every overview from PMEL — **about 40 minutes** cold,
and the only step that needs the network. One request at a time, because the
server refuses concurrent ones from a single client. `npm run data:catalog`
alone takes seconds and is enough to build the site with an empty fleet; and
`npm run data:series -- --sample 8` builds a spread across the vendors and
eras, which is enough to work on the pages.

```bash
npm run data:detail -- --season 2026
```

Builds the **full-resolution** tier for one season — every sample, in weekly
gzipped chunks. It is published from its own repository; see below.

```bash
npm run dev
```

```bash
npm run verify
```

Builds, type-checks, gates the documentation and runs the eight offline test
suites — 802 checks. Nothing in it touches the network.

## Where the data lives

Two tiers, in two kinds of repository.

| | what | where |
|---|---|---|
| **overview** | 8,000 points per record, every record | built into this site |
| **full rate** | every sample, weekly chunks | one repository per season |

The full-rate archive is **794 MB gzipped**, against GitHub Pages' 1 GB
published-site limit — so it cannot sit beside a site that is itself 250 MB.
It lives in `oceansensing/usv-data-<season>`, each published as its own Pages
site.

Those are the **same origin** as this one: a project repository under an
organisation with a Pages custom domain serves under that domain, so
`oceansensing.org/usv-data-2026/` sits beside `oceansensing.org/usv/`. The
detail tier therefore costs no cross-origin request and no relaxation of this
site's content security policy.

A season repository holds no code. Its workflow checks this one out and runs
`npm run data:detail`, which needs no token because both are public. And
because **a closed season cannot change**, its shard is built once and never
rebuilt — only the current season is on a schedule.

Published so far: **[2026](https://oceansensing.org/usv-data-2026/)**. The
other nine seasons are the same command with a different `--season`.

## Layout

```
packages/erddap-pmel/  the PMEL tabledap client: catalog, metadata, queries
packages/usv-vars/     429 vendor column names → 63 canonical quantities,
                       and which season repository holds a record's full rate
packages/usv-qc/       the nine quality checks, and how a finding is ranked
packages/plot/         the SVG plot engine, colormaps and PNG export
packages/teos10/       seawater properties, from the GSW definitions
scripts/               the data builds, and the test suites
src/                   the site
```

`CLAUDE.md` is the engineering note — what rests on what, and which of the
obvious designs turned out to be wrong. `PLAN.md` is the running record of
decisions.

## Credits

Built by **Donglai Gong** (Virginia Institute of Marine Science, William &
Mary) at the [Collaboratory for Physical
Oceanography](https://oceansensing.org/), with Claude (Anthropic).

The observations are NOAA's — PMEL, AOML and NEFSC with Saildrone Inc.,
Oshen and Chance Maritime Technologies — published on the PMEL ERDDAP, which
each page links to and each dataset's own licence and acknowledgement
govern. Sibling sites: [gliders](https://oceansensing.org/gliders/) for the
IOOS Glider DAC, and
[NOAA-USV-analysis](https://github.com/truedichotomy/NOAA-USV-analysis) for
the campaign analysis this visualization was drawn out of.

All rights reserved; see [LICENSE](LICENSE).
