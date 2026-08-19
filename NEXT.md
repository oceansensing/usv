# Next: stress-test `usv-data-2026`

The 2026 season is the **first and only** sharded season. Before the other
nine are built the same way, it needs to be wrong in every way it can be
found to be wrong — because whatever is wrong with it will be wrong nine more
times, and a published shard's URLs are a contract the site depends on.

`README.md` is for someone using the site, `CLAUDE.md` for someone changing
it, `PLAN.md` for the running record. This is the one job list.

---

## Where things stand

| | |
|---|---|
| site | https://oceansensing.org/usv/ — `oceansensing/usv` |
| shard | https://oceansensing.org/usv-data-2026/ — `oceansensing/usv-data-2026` |
| gate | `npm run verify` — 741 offline checks, eight suites |
| overview | 152 of 153 records, 1.08 M points, 2,403 findings |
| full rate | 24 records, **413,498 samples**, 74 chunks, 18m55s to build |

Both deploy from GitHub Actions. The site rebuilds four times a day; the
shard fifty minutes after it, on the same cadence, and only while the season
is open.

### Verified end to end already

- The shard serves `season.json` as `application/json` and chunks as
  `application/gzip`, byte-identical, at 60-second median cadence.
- Locally, against a replica of the production layout, a three-day window on
  `sd1030_hurricane_2026` drew **4,319 vertices** where the overview drew 720.
- The shard is the same origin as the site, so `connect-src 'self'` is
  unchanged.

---

## What to stress-test, roughly worst-first

### 1. The production path, which is not yet confirmed

Everything above was verified locally or by fetching the shard directly. At
the time of writing the site's own deploy of the detail-tier code was still
running, so **a real browser on `oceansensing.org/usv/` reading the real
shard has not been seen working**. Do that first; nothing else matters if it
does not.

Check the browser actually negotiates the `.gz` — `DecompressionStream` on a
response the CDN may or may not have touched is the fragile step, and it is
the one that cannot be tested from Node.

### 2. Records that are not `sd1030`

The window path has been exercised on one Saildrone. The 2026 season also has
thirteen Oshens at 2–5 minutes, three Chance records, and one record whose
series never built at all.

- **Oshen** cadence is 120 s on eight records and 300 s on five — a week is a
  fifth the rows, so chunk sizes and the "how many samples" sentence differ.
- **`chanceMC29_NEFSC_nantucket_2026_fullres`** has no overview because PMEL
  will not serve it. Does the detail build fail the same way, and does the
  page still say something sensible?
- **A record in the season index but with no overview**, or the reverse. The
  two tiers are built by different scripts from the same catalog and can
  disagree.

### 3. The awkward windows

- A window covering **no chunk** — a stretch the vehicle was silent through.
  `chunksFor` returns the indices; `detail.chunks` may not contain them.
- A window spanning **many weeks** — nothing caps how many chunks one window
  fetches. A reader who windows a whole mission pulls every chunk it has.
  There is no cap and probably should be.
- A window at a **chunk boundary**, and one of a single instant.
- Windowing, clearing, and windowing again; and two windows in quick
  succession, which the generation check in `loadWindow` guards against by
  reading `t0` back out of the URL.

### 4. What the reader is told

- The note is the only thing that says whether full rate is in use. Check it
  is right in all four states: unavailable, available, loading, loaded.
- **The QC still runs on the overview's resolution.** Every vehicle page says
  so, and after this change that sentence is arguably misleading — the full
  rate is right there. Either re-run the checks on it or reword.
- A browser without `DecompressionStream` should degrade to the overview with
  a sentence, and that path has never been executed.

### 5. The shard as a contract

- Chunk numbering is weeks from the Unix epoch, so it is stable across
  rebuilds. **Confirm a rebuild produces the same chunk ids**, or a reader's
  saved link breaks.
- `season.json` grows as the season does. It is fetched whole on every
  vehicle page; at 24 records it is 1 KB, but check what it is at 150.
- What happens when the shard is **absent, stale, or half-published** — a
  deploy in progress while someone is reading.

### 6. Cost, before it is multiplied by ten

- 2026 is a month in and already 74 chunks. Extrapolate to a closed season
  and confirm the 194 MB figure that the whole one-repo-per-season argument
  rests on.
- The shard build refetches every record whose `maxTime` moved — the whole
  record, not the tail. Near the end of a long season that is the expensive
  case, and it has not been seen yet.

---

## Then, and only then

Create the other nine seasons: 2017–2025. Each is
`gh repo create oceansensing/usv-data-<year> --public`, the same
`publish.yml` with the year changed and **the schedule removed** — those
seasons are closed and immutable, so they are built once by hand and never
again.

Sizes to expect, from the measured full-rate estimate:

| season | ~gzipped | | season | ~gzipped |
|---|---|---|---|---|
| 2021 | 194 MB | | 2019 | 128 MB |
| 2024 | 140 MB | | 2023 | 115 MB |
| 2018 | 77 MB | | 2022 | 72 MB |
| 2017 | 33 MB | | 2020 | 16 MB |
| 2025 | 3 MB | | | |

All well under the 1 GB limit; `shardFor` gains a vendor term if that ever
stops being true.

---

## Things known to be wrong, carried forward

- **`chanceMC29_NEFSC_nantucket_2026_fullres`** cannot be fetched at all —
  one record of 153. It costs a bounded fifteen minutes of each build and its
  page says so and links to the ERDDAP.
- **Thirteen records interleave several vehicles.** Their tracks are no
  longer drawn and both the map and the series say why, but the series still
  step between vehicles row by row. Splitting them needs `distinct()` on the
  `trajectory` column.
- **QC resolution.** As above.
- **`orderByClosest` alignment** is assumed to hold for every sensor. It was
  measured on the Saildrone SBE37 at five minutes; a sensor on some other
  period would be sampled between its rows by every rung of the ladder with
  nothing saying so. Less pressing now that the detail tier is unsampled.
