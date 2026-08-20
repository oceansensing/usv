# Next

The archive is fully sharded: ten seasons, all published, all validated
chunk by chunk. What is left is listed at the bottom.

`README.md` is for someone using the site, `CLAUDE.md` for someone changing
it, `PLAN.md` for the running record. This is the one job list.

---

## Where things stand

| | |
|---|---|
| site | https://oceansensing.org/usv/ — `oceansensing/usv` |
| gate | `npm run verify` — 929 offline checks, nine suites |
| overview | 152 of 153 records, 1.08 M points |
| full rate | **10 shards, 152 records, 2,190 chunks, 21.8 M rows, 722 MB** |

`oceansensing/usv-data-<year>` for 2017–2026, each its own Pages project site
serving at `oceansensing.org/usv-data-<year>/` — the same origin as the site,
so `connect-src 'self'` is untouched. Only 2026 has a schedule; the nine
closed seasons were built once by `workflow_dispatch` and will not be built
again.

## Every shard, read back in full

Fetched every chunk and checked it against the index: 2,190 of 2,190 served
`application/gzip` at 200.

| season | recs | chunks | rows | MB | B/value | failures |
|---|---|---|---|---|---|---|
| 2017 | 3 | 86 | 769,631 | 31.2 | 1.26 | 0 |
| 2018 | 14 | 238 | 3,577,985 | 123.7 | 1.33 | 0 |
| 2019 | 21 | 392 | 4,668,220 | **163.9** | 1.33 | 0 |
| 2020 | 10 | 154 | 782,096 | 11.4 | 0.80 | 0 |
| 2021 | 21 | 437 | 4,411,931 | 118.4 | 0.77 | 0 |
| 2022 | 14 | 187 | 1,835,760 | 66.8 | 1.13 | 0 |
| 2023 | 22 | 308 | 2,924,687 | 104.1 | 1.17 | 0 |
| 2024 | 15 | 257 | 2,317,338 | 85.5 | 0.97 | 0 |
| 2025 | 8 | 57 | 104,375 | 1.8 | 1.63 | **1** |
| 2026 | 24 | 74 | 413,586 | 15.7 | 1.28 | 0 |
| **total** | **152** | **2,190** | **21,805,609** | **722.5** | | **1** |

What "0 failures" means: every row falls in the chunk its number claims,
every declared row count and column length agrees, every span and chunk list
is right, and closed chunks come back byte-identical across a rebuild.

**The archive is 722 MB, not the 0.5 GB I last estimated** — and the original
794 MB projection, made before any shard existed, was the closest of the
three. The largest shard is 2019 at 164 MB, six times under the per-repository
limit. Estimating from the catalog is not to be trusted: it was out by 2× on
2018 and 2019, because B/value ranges from 0.77 to 1.63 across seasons and
`span / cadence` is a poor count of rows.

### The one failure, and what it turned up

`oshenPC1_hurricane_2025`: index 31,983 rows, chunks 26,490. **5,493 of its
rows carry no timestamp**, which is also why ERDDAP publishes an empty
`maxTime` for it. The chunker was right to drop them; the index reported the
count that went in. Fixed, and the shard needs rebuilding — it is the only one
that does.

The same sweep found **24 single-vehicle records whose clock runs backwards**,
`sd1034_ecmwf_ags_2021` by 1,016 of its 123,360 rows. No check looked at the
order of the clock, while the map was already lifting its pen at every one of
those steps. `timeorder` is now the tenth check.

---

## What is left

1. **Rebuild `usv-data-2025`** — the only shard with a wrong index. One
   `workflow_dispatch`.
2. **The site's next build** picks up `timeorder` and the corrected row
   counts; the detail cache format bump means the next 2026 shard build
   refetches once.
3. **Thirteen records interleave several vehicles.** Tracks are suppressed and
   both the map and the series say why, but the series still step between
   vehicles row by row. Splitting them needs `distinct()` on the `trajectory`
   column. `saildrone_arctic_2018` is the only record of the 2018 Arctic met
   and ocean data and is one of them.
4. **`chanceMC29_NEFSC_nantucket_2026_fullres`** cannot be fetched at all —
   one record of 153. It costs a bounded fifteen minutes of each build; its
   page says so and links to the ERDDAP.
5. **A shard's `cadenceSeconds` is a median over a record that may not have
   one cadence** — the Oshens and the ADCP records disagree with their own
   figure. Nothing reads the field. Make it honest or drop it.
6. **`orderByClosest` alignment** is assumed to hold for every sensor. It was
   measured on the Saildrone SBE37 at five minutes. Less pressing now that the
   detail tier is unsampled.
7. **A record's index entry is rewritten on every build** — `fetched` is
   stamped from the clock — so `season.json` never comes back byte-identical
   even where nothing moved.
