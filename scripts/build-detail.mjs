#!/usr/bin/env node
/**
 * The full-rate tier: every record of one season, at the rate its instruments
 * reported, cut into weekly chunks.
 *
 *   npm run data:detail -- --season 2026
 *   npm run data:detail -- --season 2026 --only sd1030_hurricane_2026
 *
 * Writes `detail/<datasetId>/<chunk>.json.gz` plus a `season.json` index, into
 * a directory a *shard* repository publishes as its own Pages site. See
 * `packages/usv-vars/shard.ts` for why the data lives one repository per
 * season and why that costs no CORS.
 *
 * ## This is a different question from `build-series.mjs`
 *
 * That script answers "what does this record look like" — an overview, eight
 * thousand points, one small file the vehicle page opens with. This one
 * answers "what exactly did the instrument report at 09:31" — every sample,
 * fetched only for the week a reader has windowed into.
 *
 * ## Full rate costs bytes, not server time
 *
 * The measurement the whole tier rests on: `orderByClosest` saves bytes and
 * **not** server time — 12.9 s against 12.8 s for sixty times fewer rows,
 * because ERDDAP's cost is the span it scans and the span is the same either
 * way. So asking for every row costs transfer and almost nothing else.
 *
 * ## Pre-gzipped, and that is what makes it fit
 *
 * As plain JSON the archive at full rate is 3.96 GB; gzipped it is 794 MB,
 * and GitHub Pages' limit is 1 GB of *stored* site. A static host will not
 * compress a file it does not recognise, so the chunks are stored already
 * compressed and inflated in the tab with `DecompressionStream` — the same
 * mechanism, and the same reason, as the sibling glider site's TEOS-10 atlas.
 * Verified against the live host: a `.gz` comes back byte-identical under
 * `content-type: application/gzip`.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ErddapError, fetchTable, medianCadence, PMEL,
} from '../packages/erddap-pmel/index.ts';
import {
  applyConversion, CHUNK_SECONDS, chunkSpan, resolveDataset, seasonOf, shardFor,
} from '../packages/usv-vars/index.ts';
import {
  Cache, groupByChunk, human, infoCache, roundColumn, roundTime, writeJson,
} from './lib/bake.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const CATALOG = root('public/data/catalog.json');
const CACHE = root('.cache/detail');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const season = flag('--season');
const only = flag('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const refresh = args.includes('--refresh');
/* `--out` may be absolute — CI passes one — so it is only resolved against
   the repository when it is not. `root()` on an absolute path silently
   produces a directory somewhere else entirely, which is how the first run
   of this wrote its chunks outside the tree and reported success. */
const outFlag = flag('--out') ?? 'detail';
const OUT_DIR = path.isAbsolute(outFlag) ? outFlag : root(outFlag);

if (!season) {
  console.error('--season is required, e.g. --season 2026');
  process.exit(1);
}
if (!fs.existsSync(CATALOG)) {
  console.error('public/data/catalog.json is missing. Run `npm run data:catalog` first.');
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const shard = shardFor(`x-${season}`);

/** How many columns a chunk carries. The same cap the overview uses, and for
    the same reason: past forty it is mostly channels nobody opens. */
const MAX_COLUMNS = 40;

/**
 * How many rows one request may bring back.
 *
 * Higher than the overview's budget because this tier *is* the full rate —
 * but not unbounded: a 431-day record at one minute is 620,000 rows and
 * about 250 MB decoded, which is a long single response to hold in memory
 * and to lose to one timeout. Records past this are fetched a year at a
 * time.
 */
const ROWS_PER_REQUEST = 200_000;

let targets = catalog.datasets.filter(
  (d) => d.kind !== 'files' && seasonOf(d.campaign) === season,
);
if (only) targets = targets.filter((d) => only.includes(d.id));

if (!targets.length) {
  console.error(`No records in season ${season}.`);
  process.exit(1);
}

console.log(`${shard}: ${targets.length} records`);
fs.mkdirSync(OUT_DIR, { recursive: true });
/**
 * What a cached entry of this build contains.
 *
 * Bump on any change to a chunk's shape or contents — the columns kept, the
 * rounding, the chunk boundaries, the index fields. A closed season is built
 * once, so a change that does not bump this reaches nothing at all. See
 * `Cache`.
 *
 * 2 — the index reported the rows *fetched* rather than the rows written, so
 *     `oshenPC1_hurricane_2025` promised 31,983 samples for a shard holding
 *     26,490; 5,493 of its rows carry no timestamp and belong to no week.
 * 1 — the first published shape.
 */
const CACHE_FORMAT = 2;

const cache = new Cache(CACHE, CACHE_FORMAT);

/* Written by `data:catalog`; read here rather than asking PMEL again. */
const INFO = infoCache();
const started = Date.now();

const index = [];
let bytes = 0;
let failed = 0;

for (const [n, d] of targets.entries()) {
  const label = `[${String(n + 1).padStart(3)}/${targets.length}] ${d.id}`;
  try {
    const stamp = Cache.stamp(d);
    const cached = refresh ? undefined : cache.read(d.id, stamp);
    const built = cached ?? await buildOne(d);
    if (!built) { failed++; console.log(`${label}  ! nothing fetched`); continue; }
    if (!cached) cache.write(d.id, stamp, built);

    /* Written every run even from cache: the shard's published output is
       rebuilt from scratch each time, so a cached record still has to put
       its files there. */
    const dir = path.join(OUT_DIR, d.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [chunk, payload] of Object.entries(built.chunks)) {
      const gz = zlib.gzipSync(Buffer.from(payload), { level: 9 });
      fs.writeFileSync(path.join(dir, `${chunk}.json.gz`), gz);
      bytes += gz.length;
    }
    index.push(built.summary);
    console.log(`${label}  ${built.summary.rows.toLocaleString()} rows, `
      + `${built.summary.chunks.length} chunks${cached ? ', cached' : ''}`);
  } catch (error) {
    failed++;
    console.log(`${label}  ! ${error.message}`);
  }
}

/**
 * The season's own index.
 *
 * The site reads this to know which chunks exist before asking for one — a
 * 404 for a week a vehicle was not reporting is indistinguishable in a
 * browser from the shard being down.
 */
index.sort((a, b) => a.id.localeCompare(b.id));
const indexBytes = writeJson(path.join(OUT_DIR, 'season.json'), {
  shard,
  season,
  built: Math.floor(started / 1000),
  source: PMEL,
  records: index,
});

console.log(`\n${index.length}/${targets.length} records, ${human(bytes)} of chunks `
  + `+ ${human(indexBytes)} index`);
console.log(`${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);

/* Same rule as the overview build: one record the archive will not give up
   must not stop a season being published, and losing most of them must. */
if (!index.length) {
  console.log('\nNothing was built. Not publishing this.');
  process.exitCode = 1;
} else if (failed / targets.length > 0.05) {
  console.log(`\n${failed} of ${targets.length} records failed, past the 5 % this `
    + 'tolerates. Not publishing this.');
  process.exitCode = 1;
} else if (failed) {
  console.log(`\n${failed} record${failed === 1 ? '' : 's'} could not be fetched. `
    + 'The season is published from the rest.');
}

/* ------------------------------------------------------------ one record -- */

async function buildOne(d) {
  const info = INFO.read(d.id, Cache.stamp(d));
  if (!info) throw new Error(`no cached info for ${d.id} — run data:catalog first`);
  const resolved = resolveDataset(info.variables);

  const wanted = pickColumns(resolved);
  const columns = ['time', info.latVar, info.lonVar, ...wanted.map((r) => r.column)];

  /* Windowed only where the record is too long for one response. The window
     is a year, which is longer than every mission in the archive bar two. */
  const windows = splitSpan(d.start, d.end);
  const parts = [];
  for (const [from, to] of windows) {
    try {
      parts.push(await fetchTable(d.id, columns, {
        base: PMEL, start: from, end: to, retries: 2,
      }));
    } catch (error) {
      /* A window with no rows is an answer: a vehicle silent for a stretch,
         or a span that runs past the record. */
      if (error instanceof ErddapError && error.empty) continue;
      throw error;
    }
  }
  const rows = parts.reduce((sum, p) => sum + p.rows, 0);
  if (!rows) return undefined;

  /* One table again. The windows were a transfer decision and nothing below
     should be able to tell they happened. */
  const time = concat(parts.map((p) => p.time), rows);
  const lat = concat(parts.map((p) => p.columns.get(info.latVar)), rows);
  const lon = concat(parts.map((p) => p.columns.get(info.lonVar)), rows);

  const values = new Map();
  for (const r of wanted) {
    const merged = concat(parts.map((p) => p.columns.get(r.column)), rows);
    if (!merged) continue;
    applyConversion(merged, r.conversion);
    values.set(seriesKey(r, resolved), { column: merged, resolved: r });
  }

  /* See `groupByChunk`: a row with no timestamp belongs to no week and is
     not written, so `placed` — not `rows` — is what this record contributes. */
  const { groups, placed, dropped } = groupByChunk(time, CHUNK_SECONDS);
  if (dropped) {
    console.log(`    ${d.id}: ${dropped} of ${rows} rows have no timestamp and are not chunked`);
  }

  const chunks = {};
  for (const [chunk, rowsIn] of groups) {
    const span = chunkSpan(chunk);
    const payload = {
      id: d.id,
      chunk,
      from: span.from,
      to: span.to,
      rows: rowsIn.length,
      time: roundTime(pick(time, rowsIn)),
      lat: roundColumn(pick(lat, rowsIn), 5),
      lon: roundColumn(pick(lon, rowsIn), 5),
      columns: Object.fromEntries([...values].map(([key, v]) => [
        key, roundColumn(pick(v.column, rowsIn), v.resolved.quantity?.digits ?? 3),
      ])),
    };
    chunks[chunk] = JSON.stringify(payload);
  }

  const cadence = medianCadence(time);
  return {
    chunks,
    summary: {
      id: d.id,
      vehicle: d.vehicle,
      campaign: d.campaign,
      /* What the chunks actually hold. Reporting the fetched count instead
         made the index claim 31,983 samples for a record whose shard held
         26,490, and the vehicle page prints this number as a promise. */
      rows: placed,
      cadenceSeconds: cadence,
      /* Sorted, so a rebuild that changed nothing writes a byte-identical
         index and the diff between builds is only what moved. */
      chunks: [...groups.keys()].sort((a, b) => a - b),
      variables: [...values.keys()].sort(),
      fetched: Math.floor(Date.now() / 1000),
    },
  };
}

/* ------------------------------------------------------------- helpers -- */

/** A record's span, cut into requests small enough to hold and to retry. */
function splitSpan(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [[undefined, undefined]];
  }
  /* A year at one minute is 525,600 rows — past the budget — so the window
     is sized from the budget and a one-minute assumption, which is the
     fastest anything here reports. */
  const window = ROWS_PER_REQUEST * 60;
  if (end - start <= window) return [[start, end]];
  const out = [];
  for (let from = start; from < end; from += window) {
    out.push([from, Math.min(from + window, end)]);
  }
  return out;
}

function concat(arrays, rows) {
  const present = arrays.filter(Boolean);
  if (!present.length) return undefined;
  const out = new Float64Array(rows);
  let at = 0;
  for (const a of present) { out.set(a, at); at += a.length; }
  /* A column absent from one window and present in another leaves the gap as
     NaN rather than shifting everything after it. */
  for (let i = at; i < rows; i++) out[i] = NaN;
  return out;
}

/* A declaration, not a `const` arrow: the build loop is at module top level
   and runs before the trailing `const`s are initialised, so an arrow here is
   in its temporal dead zone when the first record asks for it. `concat` and
   the rest are declarations for the same reason. */
function pick(values, rows) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = values ? values[rows[i]] : NaN;
  return out;
}

function pickColumns(resolved) {
  const means = resolved.columns.filter((r) => r.statistic === 'mean');
  const named = means.filter((r) => r.quantity)
    .sort((a, b) => a.quantity.rank - b.quantity.rank || a.column.localeCompare(b.column));
  const unnamed = means.filter((r) => !r.quantity && !r.faults.length)
    .sort((a, b) => a.column.localeCompare(b.column));
  return [...named, ...unnamed].slice(0, MAX_COLUMNS);
}

/** The same keying the overview uses, so a chunk's columns line up with the
    variables the page already knows about. */
function seriesKey(r, resolved) {
  if (r.quantity && resolved.primary.get(r.quantity.key) === r) return r.quantity.key;
  return r.column;
}
