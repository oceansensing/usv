# Next: the other nine seasons

The 2026 shard has been stress-tested and is in final form. What follows is
the replication, and the handful of things the stress test found that are
still open.

`README.md` is for someone using the site, `CLAUDE.md` for someone changing
it, `PLAN.md` for the running record. This is the one job list.

---

## Where things stand

| | |
|---|---|
| site | https://oceansensing.org/usv/ — `oceansensing/usv` |
| shard | https://oceansensing.org/usv-data-2026/ — `oceansensing/usv-data-2026` |
| gate | `npm run verify` — 792 offline checks, eight suites |
| overview | 152 of 153 records, 1.08 M points, 2,403 findings |
| full rate | 24 records, **413,498 samples**, 74 chunks, **15.66 MB** |

Both deploy from GitHub Actions. The site rebuilds four times a day; the
shard fifty minutes after it, on the same cadence, and only while the season
is open.

---

## What the stress test established

Read back in full on 2026-08-19 — all 74 chunks, the live site in a real
browser, and a replica of the production layout for the paths production
cannot be made to take.

**Sound, and now measured rather than assumed:**

- **The contract holds.** Every row falls in the chunk its number claims;
  every declared row count, column length and span agrees; chunk lists are
  sorted and contiguous. 0 failures across 74 chunks and 12.85 M values.
- **Closed chunks are byte-identical across rebuilds**, so a saved link keeps
  working. Only the open week churns.
- **Both tiers agree**: 24 shard records ↔ 24 overviews. The 12 records with
  neither are 11 `files` records and the one PMEL will not serve.
- **All three vendors work**, not just the Saildrone the tier was built on —
  Oshen at 120 s and 300 s, Chance at 60 s.
- **The failure paths degrade honestly.** A missing chunk and a missing shard
  both 404 and are handled; the page keeps the overview and names the reason.
- `season.json` is 11 KB and **per season**, so it never approaches the 150
  records the whole catalog holds — 24 is near the largest a season gets.
- The encoding is **1.28 B/value gzipped**, and the archive re-predicts to
  0.66 GB total, largest season 168 MB. Both in `CLAUDE.md` §3.

**Fixed, in `86d8f5a`:** the uncapped window, the tier offered where it is
not finer, and two fallbacks that announced the overview without returning to
it. All four are in `CLAUDE.md` §7 with how they looked.

**Retired:** the worry that the QC's resolution note would read as misleading
once full rate was beside it. Measured — every 2026 Saildrone and Chance
record already runs its checks at native rate, because the QC runs before the
decimation. Only the drifting-cadence Oshens read coarser, and there the note
is a true statement about a real cadence change. It becomes live again for
2021 and 2024, whose long records are checked at 5 minutes.

---

## The replication

Nine seasons: 2017–2025. Each is
`gh repo create oceansensing/usv-data-<year> --public`, the same
`publish.yml` with the year changed and **the schedule removed** — those
seasons are closed and immutable, so they are built once by hand and never
again.

Sizes to expect, from the shard-calibrated estimate (aggregate 1.009×;
trust it per season, not per record):

| season | ~gzipped | longest record | | season | ~gzipped | longest record |
|---|---|---|---|---|---|---|
| 2021 | 168 MB | 63 wk | | 2019 | 102 MB | 31 wk |
| 2024 | 121 MB | 33 wk | | 2023 | 100 MB | 27 wk |
| 2018 | 62 MB | 23 wk | | 2022 | 63 MB | 20 wk |
| 2017 | 28 MB | 37 wk | | 2020 | 13 MB | 22 wk |
| 2025 | 2 MB | 12 wk | | | | |

All far under the 1 GB limit; `shardFor` gains a vendor term if that ever
stops being true.

**Watch for, in that order:**

1. **The build cost, which has only been seen on one month.** The detail
   build refetches every record whose `maxTime` moved — the whole record, not
   the tail. A closed season never moves, so each is one build; but that one
   build is 63 weeks of 1-minute data for `sd1065_tpos_2021` against a server
   that takes **one request at a time** and 43 s cold for 190 k rows. Expect
   hours, not the 19 minutes 2026 takes, and check the workflow timeout
   before starting rather than after.
2. **The long records are the first to exceed the window cap**, which 2026
   never could. Confirm the cap's message reads sensibly on a 63-week record
   — that is the case it was written for and the only place it will be seen.
3. **The QC resolution note**, live again on records checked at 5 minutes.
4. **2021 and 2024 both hold multi-vehicle records.** Their tracks are
   already suppressed; their series still interleave.

---

## Things known to be wrong, carried forward

- **`chanceMC29_NEFSC_nantucket_2026_fullres`** cannot be fetched at all —
  one record of 153. It costs a bounded fifteen minutes of each build and its
  page says so and links to the ERDDAP.
- **Thirteen records interleave several vehicles.** Their tracks are no
  longer drawn and both the map and the series say why, but the series still
  step between vehicles row by row. Splitting them needs `distinct()` on the
  `trajectory` column.
- **A shard's `cadenceSeconds` is a median over a record that may not have
  one cadence** — 11 of 15 Oshen chunks disagree with their own record's
  figure. Nothing reads it, so nothing is wrong on screen. Make it honest or
  drop it before something starts to.
- **`orderByClosest` alignment** is assumed to hold for every sensor. It was
  measured on the Saildrone SBE37 at five minutes; a sensor on some other
  period would be sampled between its rows by every rung of the ladder with
  nothing saying so. Less pressing now that the detail tier is unsampled.
- **A record's index entry is rewritten on every build** — `fetched` is
  stamped from the clock — so `season.json` never comes back byte-identical
  even where nothing moved, against the intent of the comment beside it. It
  costs nothing; it makes "what changed in this build" harder to read.
