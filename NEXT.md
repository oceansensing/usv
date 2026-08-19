# Next: the remaining eight seasons

2026 and 2021 are published and validated — the smallest season and the
largest. Eight remain, and they are all between the two.

`README.md` is for someone using the site, `CLAUDE.md` for someone changing
it, `PLAN.md` for the running record. This is the one job list.

---

## Where things stand

| | |
|---|---|
| site | https://oceansensing.org/usv/ — `oceansensing/usv` |
| gate | `npm run verify` — 833 offline checks, nine suites |
| overview | 152 of 153 records, 1.08 M points, 2,403 findings |
| **2026** | https://oceansensing.org/usv-data-2026/ — 24 records, 74 chunks, **15.7 MB** |
| **2021** | https://oceansensing.org/usv-data-2021/ — 21 records, 437 chunks, **118.4 MB** |

The site rebuilds four times a day; the 2026 shard fifty minutes after it, on
the same cadence, and only while the season is open. **2021 has no schedule**
— it is closed, so it was built once by `workflow_dispatch` and never again.

---

## What the two shards established

Both were read back in full — 511 chunks, 174 M values — and driven in a real
browser.

- **The contract holds.** Every row falls in the chunk its number claims;
  every declared row count, column length and span agrees; chunk lists are
  sorted. **0 failures**, both seasons.
- **Closed chunks are byte-identical across rebuilds**, so a saved link keeps
  working. Only the open week churns.
- **Both tiers agree** in both seasons: every shard record has an overview and
  every plottable record has a shard entry.
- **All three vendors work** — Oshen at 120 s and 300 s, Chance at 60 s,
  Saildrone at 60 s.
- **The window cap fires on the case it was written for.** The whole of
  `sd1065_tpos_2021`, 63 weeks, asks for nothing and says why. Nothing in
  2026 could ever have reached it.
- **The failure paths degrade honestly** — a missing chunk and a missing
  shard both 404 and are handled.

### The two encodings, and which to trust

| | 2026 | 2021 |
|---|---|---|
| what it is | short Oshen runs, many small files | long Saildrone runs |
| gzipped | **1.28 B/value** | **0.77 B/value** |

The big seasons are all the second kind, so **0.77 is the number to plan
with** and 1.28 was pessimism from a season unlike the rest. It puts the whole
archive near **0.5 GB**, against a 1 GB limit that applies per repository
anyway. The largest season is now measured, not estimated, at 118 MB.

### A correction to what this file said last

It said the QC-resolution worry was **retired** — that the checks run before
the decimation, so the note reading "coarser than the vehicle reported" was
about to become misleading. That was wrong, and reading 2021 is what showed
it: the page claimed `sd1065_tpos_2021` was checked at native rate while its
own series file recorded a 300 s fetch against a 60 s vehicle.

`coverageNote` was comparing the fetch resolution against the spacing of the
rows it had been handed — the same number by construction on a decimated
fetch — so its warning branch **could never fire**, and **46 of 152 records**
told a reader their one-minute artifacts had been looked for. Fixed; in
`CLAUDE.md` §7, and `test:qc` now covers the function, which nothing had.

**The 46 corrected notes appear at the next site rebuild**, since the note is
baked into each series file.

---

## The replication

Eight seasons: 2017–2020, 2022–2025. For each:

1. `gh repo create oceansensing/usv-data-<year> --public`
2. push `README.md` and `.github/workflows/publish.yml` — the 2021 pair with
   the year changed; **no schedule**, `workflow_dispatch` only
3. `gh api -X POST repos/oceansensing/usv-data-<year>/pages -f build_type=workflow`,
   then `-X PUT … -F https_enforced=true`
4. `gh workflow run publish.yml --repo oceansensing/usv-data-<year>`
5. validate: fetch every chunk, check the contract, check tier agreement

Sizes to expect, from 2021 measured and scaled:

| season | ~size | | season | ~size |
|---|---|---|---|---|
| 2024 | ~88 MB | | 2019 | ~74 MB |
| 2023 | ~72 MB | | 2022 | ~46 MB |
| 2018 | ~44 MB | | 2017 | ~20 MB |
| 2020 | ~10 MB | | 2025 | ~1 MB |

**Build time is not the problem it was feared to be.** 2021 — the largest
season, 4.4 M rows at native rate — took **7m12s**, against a model that said
42 minutes. The model was fitted to cold-fetch measurements and PMEL's cache
was warmer than that; either way every remaining season is smaller. The
120-minute timeout stays anyway, because it costs nothing unused and a
timeout burns the run *and* saves no cache.

Nothing forces the eight to be serial, but PMEL takes **one request at a
time** across all of them — the 408 that cost a dataset earlier in this
project. Run them one at a time.

---

## Things known to be wrong, carried forward

- **`chanceMC29_NEFSC_nantucket_2026_fullres`** cannot be fetched at all —
  one record of 153. It costs a bounded fifteen minutes of each build and its
  page says so and links to the ERDDAP.
- **Thirteen records interleave several vehicles**, and 2021's
  `all_swfsc_2021` is one: it is the only record in that season whose time
  steps backwards, 30 chunks of it, which is the interleaving showing through
  rather than a fault in the data. Tracks are already suppressed; the series
  still step between vehicles row by row. Splitting them needs `distinct()`
  on the `trajectory` column.
- **A shard's `cadenceSeconds` is a median over a record that may not have
  one cadence** — 11 of 15 Oshen chunks disagree with their own record's
  figure. 2021 is all Saildrone and has no drift at all. Nothing reads the
  field. Make it honest or drop it before something starts to.
- **`orderByClosest` alignment** is assumed to hold for every sensor. It was
  measured on the Saildrone SBE37 at five minutes; a sensor on some other
  period would be sampled between its rows by every rung of the ladder with
  nothing saying so. Less pressing now that the detail tier is unsampled.
- **A record's index entry is rewritten on every build** — `fetched` is
  stamped from the clock — so `season.json` never comes back byte-identical
  even where nothing moved, against the intent of the comment beside it. It
  costs nothing; it makes "what changed in this build" harder to read.
