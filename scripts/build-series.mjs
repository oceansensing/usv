#!/usr/bin/env node
/**
 * The series: every number the site draws, one file per record.
 *
 *   npm run data:series
 *   npm run data:series -- --only sd1030_hurricane_2026,oshenPD11_hurricane_2026
 *   npm run data:series -- --sample 8          (a spread across vendors and eras)
 *   npm run data:series -- --refresh           (ignore the cache)
 *
 * The slow half of the data build, and the reason the site exists as a
 * static one. PMEL sends no CORS header, so this cannot run in a browser;
 * it runs here, checks what it fetched, and writes JSON the page reads from
 * its own origin.
 *
 * Each record becomes `public/data/series/<id>.json` — loaded only when a
 * reader opens that vehicle. The fleet page never touches them.
 *
 * ## What happens to one record
 *
 *  1. **Probe its cadence** — two tiny `time`-only requests, near each end of
 *     the record, keeping the finer. Needed before anything else, and needed
 *     at *both* ends because a record's cadence changes: `oshenPD22` reports
 *     every two minutes in early August and every ten by the 19th.
 *  2. **Choose the rung** from the span and that cadence, so the fetch lands
 *     under `FETCH_ROWS`.
 *  3. **Fetch the columns the site draws**, and only those — asking for all
 *     of them costs ten times the bytes for the same rows.
 *  4. **Convert units**, so knots and radians become m/s and degrees.
 *  5. **Derive** U₁₀, wind stress, dewpoint, specific humidity and the
 *     TEOS-10 surface set.
 *  6. **Run the QC at the fetched resolution** — before decimation, so a
 *     single-sample artifact is found at the finest rate available.
 *  7. **Decimate to `DISPLAY_POINTS`** and round each column to what its
 *     instrument resolves.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  chooseRung, DISPLAY_POINTS, ErddapError, fetchTable, medianCadence, PMEL,
} from '../packages/erddap-pmel/index.ts';
import {
  applyConversion, BY_KEY, dewpoint, resolveDataset, seawater, specificHumidity,
  u10Neutral, WIND_HEIGHT, windStress,
} from '../packages/usv-vars/index.ts';
import { coverageNote, run as runQc, worst } from '../packages/usv-qc/index.ts';
import { decodeAtlas } from '../packages/teos10/index.ts';
import {
  Cache, decimateIndices, human, pool, roundColumn, roundTime, take, writeJson,
} from './lib/bake.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const CATALOG = root('public/data/catalog.json');
const OUT_DIR = root('public/data/series');
const CACHE = root('.cache/series');

/** How many columns a record's series file carries.
 *
 *  A Chance record declares 101 variables, 50 of them `_MEAN`; a 2019
 *  Saildrone declares 125. Past about forty the file is mostly channels
 *  nobody opens, and the ones a reader wants are the ones that resolved to a
 *  canonical quantity — which is what the ordering below puts first. */
const MAX_COLUMNS = 40;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const refresh = args.includes('--refresh');
const only = flag('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const sampleCount = Number(flag('--sample')) || 0;

if (!fs.existsSync(CATALOG)) {
  console.error('public/data/catalog.json is missing. Run `npm run data:catalog` first.');
  process.exit(1);
}
const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

/* The salinity anomaly atlas, read here and never shipped: the site bakes
   the seawater properties, so the browser has no use for 192 KB of lookup
   table. Without it Absolute Salinity is Reference Salinity wearing SA's
   name, and the anomaly reaches 0.03 g/kg — thirty times the precision
   density is quoted to. */
let atlas = null;
try {
  const gz = fs.readFileSync(root('scripts/data/saar.bin.gz'));
  const raw = zlib.gunzipSync(gz);
  atlas = decodeAtlas(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  console.log('salinity anomaly atlas loaded');
} catch (error) {
  console.log(`! no salinity atlas (${error.message}); `
    + 'Absolute Salinity will be Reference Salinity and every record will say so');
}

/* -------------------------------------------------------------- select -- */

let targets = catalog.datasets.filter((d) => d.kind !== 'files');
if (only) targets = targets.filter((d) => only.includes(d.id));
if (sampleCount) {
  /* A spread rather than the first N: the point of a sample build is to see
     every vendor and every naming era, and the catalog is sorted by recency
     so the first N are all one campaign. */
  const byVendor = new Map();
  for (const d of targets) {
    const list = byVendor.get(d.vendor) ?? [];
    list.push(d);
    byVendor.set(d.vendor, list);
  }
  const picked = [];
  const vendors = [...byVendor.keys()];
  for (let i = 0; picked.length < sampleCount; i++) {
    let added = false;
    for (const v of vendors) {
      const list = byVendor.get(v);
      const stride = Math.max(1, Math.floor(list.length / Math.ceil(sampleCount / vendors.length)));
      const d = list[i * stride];
      if (d && !picked.includes(d) && picked.length < sampleCount) { picked.push(d); added = true; }
    }
    if (!added) break;
  }
  targets = picked;
}

console.log(`${targets.length} records to build`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const cache = new Cache(CACHE);
const started = Date.now();

/* -------------------------------------------------------------- build -- */

/**
 * **One request at a time, because PMEL says so in as many words.**
 *
 * A request that arrives while another from the same client is still running
 * does not queue politely — it waits and then fails with a 408 whose body
 * reads *"Timeout waiting for your other requests to process. Please make
 * just one request at a time."* The first full build ran three at a time and
 * lost `chanceMC29_NEFSC_nantucket_2026_fullres` to it three attempts
 * running, and every manual request made while that build was going got the
 * same 408.
 *
 * It costs nothing. Measured early on, four parallel requests to this server
 * took 4.3 s against ~4.4 s of serial time — it serialises internally
 * anyway, so the only thing concurrency bought was failures.
 */
const summaries = await pool(targets, 1, async (d, index) => {
  const label = `[${String(index + 1).padStart(3)}/${targets.length}] ${d.id}`;
  try {
    const stamp = Number.isFinite(d.end) ? Math.round(d.end) : 'none';
    const cached = refresh ? undefined : cache.read(d.id, stamp);
    if (cached) {
      writeJson(`${OUT_DIR}/${d.id}.json`, cached.series);
      console.log(`${label}  cached`);
      return cached.summary;
    }

    const built = await buildOne(d);
    if (!built) return undefined;
    cache.write(d.id, stamp, built);
    const bytes = writeJson(`${OUT_DIR}/${d.id}.json`, built.series);
    const s = built.summary;
    console.log(`${label}  ${s.rows} rows, ${s.variables} vars, `
      + `${s.resolutionSeconds / 60}-min, ${s.findings} findings, ${human(bytes)}`);
    return s;
  } catch (error) {
    console.log(`${label}  ! ${error.message}`);
    return undefined;
  }
});

/* --------------------------------------------------- merge into catalog -- */

/* **Re-read the catalog before merging, rather than using the copy this run
   started with.** A full build takes forty minutes, and `build-catalog.mjs`
   can be re-run in that time — as it was, the first time this was written,
   whereupon the finished series build wrote its stale in-memory copy back
   over the fresh one and every field the catalog had gained went away
   again. */
const merged = fs.existsSync(CATALOG)
  ? JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
  : catalog;

const byId = new Map(summaries.filter(Boolean).map((s) => [s.id, s]));
for (const d of merged.datasets) {
  const s = byId.get(d.id);
  if (!s) continue;
  d.rows = s.rows;
  d.cadenceSeconds = s.cadenceSeconds;
  d.resolutionSeconds = s.resolutionSeconds;
  d.severity = s.severity ?? null;
  d.findings = s.findings;
  d.checks = s.checks;
  d.seriesFetched = s.fetched;
}
merged.seriesBuilt = Math.floor(started / 1000);
writeJson(CATALOG, merged);

const built = summaries.filter(Boolean).length;
const bytes = fs.readdirSync(OUT_DIR)
  .reduce((sum, f) => sum + fs.statSync(`${OUT_DIR}/${f}`).size, 0);
console.log(`\n${built}/${targets.length} built, ${human(bytes)} in public/data/series/`);
console.log(`${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);

/**
 * **A record the archive will not give up must not block the deploy.**
 *
 * The first CI run fetched 152 of 153 in 37.9 minutes — every byte of it
 * correct — and then this script exited 1 because one record was missing,
 * which failed the build, skipped the upload, and left the site unpublished.
 * It also threw the 38 minutes away: `actions/cache` saves under
 * `post-if: success()`, so a failed job keeps nothing.
 *
 * A site with 99 % of the archive is better than no site. A site with half
 * of it is worse than the one already published, because it would silently
 * replace it. So the gate is a *fraction*, and the two ends are named: any
 * failure is reported, a large share of them stops the deploy.
 */
const missing = targets.length - built;
const TOLERATED = 0.05;
if (built === 0) {
  console.log('\nNothing was built. Not deploying this.');
  process.exitCode = 1;
} else if (missing / targets.length > TOLERATED) {
  console.log(`\n${missing} of ${targets.length} records could not be fetched, `
    + `past the ${TOLERATED * 100} % this tolerates. Not deploying this.`);
  process.exitCode = 1;
} else if (missing) {
  console.log(`\n${missing} record${missing === 1 ? '' : 's'} could not be fetched. `
    + 'The site is built from the rest, and each missing one says so on its own '
    + 'page and links to the ERDDAP.');
}

/* ------------------------------------------------------------ one record -- */

async function buildOne(d) {
  const info = JSON.parse(fs.readFileSync(
    infoCachePath(d), 'utf8'));
  const resolved = resolveDataset(info.variables);

  /* 1. Cadence. Probed rather than assumed, because everything downstream is
        relative to it — the rung, the gap threshold, and the sentence saying
        what the QC could not have seen. The probe is the last few hours,
        where an active mission certainly has rows; a 404 there means the
        record ends earlier than `maxTime` claims, and the vendor default is
        the honest fallback. */
  const nativeCadence = await probeCadence(d);

  /* 2. The rung. */
  const span = d.end - d.start;
  const minutes = chooseRung(span, nativeCadence);

  /* 3. The columns. Resolved ones first, ordered by the quantity's own rank,
        so a truncated file keeps pressure and wind rather than magnetometer
        axes. */
  const wanted = pickColumns(resolved);
  const columns = ['time', info.latVar, info.lonVar, ...wanted.map((r) => r.column)];

  let table;
  try {
    table = await fetchTable(d.id, columns, {
      base: PMEL, minutes, cadenceSeconds: nativeCadence, retries: 2,
    });
  } catch (error) {
    if (error instanceof ErddapError && error.empty) {
      console.log(`   ${d.id}: the server reports no rows at all`);
      return undefined;
    }
    throw error;
  }
  if (!table.rows) return undefined;

  const time = table.time;
  const lat = table.columns.get(info.latVar) ?? new Float64Array(table.rows);
  const lon = table.columns.get(info.lonVar) ?? new Float64Array(table.rows);

  /* The spacing of the rows actually in hand, which is what `gaps` must be
     measured against — a gap is an interruption in *this* series, and after
     decimation the vehicle's native interval is no longer what the rows are
     spaced by. `nativeCadence` stays separate and is what the coverage note
     compares the fetch resolution to. */
  const seriesCadence = medianCadence(time) || nativeCadence;

  /* 4. Units. In place — these are freshly parsed arrays nothing else
        holds. */
  const canonical = new Map();
  for (const r of wanted) {
    const raw = table.columns.get(r.column);
    if (!raw) continue;
    applyConversion(raw, r.conversion);
    /* Keyed by the *column* here, not the quantity: several columns can share
       a quantity and only one of them is primary. */
    canonical.set(r.column, raw);
  }

  /* The QC and the derived quantities want one column per quantity, and it
     has to be the primary one. */
  const primary = new Map();
  for (const [key, r] of resolved.primary) {
    const values = canonical.get(r.column);
    if (values) primary.set(key, values);
  }

  /* 5. Derived. */
  const derived = deriveAll(primary, lat, lon, d.vendor, table.rows);
  for (const [key, values] of derived) primary.set(key, values);

  /* 6. QC, at the resolution actually fetched — before any decimation, so a
        single-sample artifact is looked for at the finest rate available. */
  const fetched = Math.floor(Date.now() / 1000);
  const report = runQc({
    info,
    resolved,
    vendor: d.vendor,
    time,
    columns: primary,
    lat,
    lon,
    resolutionSeconds: table.resolution.kind === 'decimated'
      ? table.resolution.minutes * 60
      : nativeCadence,
    /* The spacing of the rows being checked, which `gaps` and the sparse test
       judge against — and, separately, the rate the vehicle actually reports
       at, which is the only honest thing to compare the fetch resolution
       with. They are equal only when the fetch ran at full rate. */
    cadenceSeconds: seriesCadence,
    nativeCadenceSeconds: nativeCadence,
    fetched,
  });

  /* 7. Decimate and round. */
  const keep = decimateIndices(table.rows, DISPLAY_POINTS);
  const variables = [];
  const out = {};

  for (const r of wanted) {
    const values = canonical.get(r.column);
    if (!values) continue;
    const q = r.quantity;
    const key = seriesKey(r, resolved);
    variables.push({
      key,
      quantity: q?.key ?? null,
      column: r.column,
      label: r.label,
      short: q?.short ?? r.label,
      units: q?.units ?? r.conversion.units,
      publishedUnits: r.publishedUnits,
      converted: r.conversion.converts,
      colormap: q?.colormap ?? 'viridis',
      group: q?.group ?? 'platform',
      rank: q?.rank ?? 900,
      sensor: r.sensor,
      statistic: r.statistic,
      floor: q?.floor ?? null,
      note: q?.note ?? null,
      derived: false,
    });
    out[key] = roundColumn(take(values, keep), q?.digits ?? 3);
  }

  for (const [key, values] of derived) {
    const q = BY_KEY.get(key);
    if (!q) continue;
    variables.push({
      key,
      quantity: key,
      column: null,
      label: q.label,
      short: q.short,
      units: q.units,
      publishedUnits: '',
      converted: false,
      colormap: q.colormap,
      group: q.group,
      rank: q.rank,
      sensor: '',
      statistic: 'mean',
      floor: q.floor ?? null,
      note: q.note ?? null,
      derived: true,
    });
    out[key] = roundColumn(take(values, keep), q.digits);
  }

  variables.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));

  const series = {
    id: d.id,
    title: d.title,
    vendor: d.vendor,
    vehicle: d.vehicle,
    multiVehicle: d.multiVehicle,
    campaign: d.campaign,
    campaignLabel: d.campaignLabel,
    institution: d.institution,
    attributes: d.attributes,
    fetched,
    source: PMEL,
    /* Both, always: what the fetch asked for and what the file holds. A page
       that prints only the second implies the checks ran on it. */
    resolutionSeconds: report.resolutionSeconds,
    cadenceSeconds: nativeCadence,
    seriesCadenceSeconds: seriesCadence,
    fetchedRows: table.rows,
    rows: keep ? keep.length : table.rows,
    decimated: Boolean(keep),
    anomalyApplied: Boolean(atlas),
    time: roundTime(take(time, keep)),
    lat: roundColumn(take(lat, keep), 5),
    lon: roundColumn(take(lon, keep), 5),
    variables,
    columns: out,
    qc: report,
    qcNote: coverageNote(report),
  };

  return {
    series,
    summary: {
      id: d.id,
      rows: series.rows,
      variables: variables.length,
      cadenceSeconds: nativeCadence,
      resolutionSeconds: report.resolutionSeconds,
      severity: worst(report.findings) ?? null,
      findings: report.findings.length,
      checks: countChecks(report.findings),
      fetched,
    },
  };
}

/* ------------------------------------------------------------- helpers -- */

function infoCachePath(d) {
  const stamp = Number.isFinite(d.end) ? Math.round(d.end) : 'none';
  return root(`.cache/info/${d.id}@${String(stamp).replace(/[^0-9]/g, '')}.json`);
}

/**
 * The **finest** interval the vehicle reported at, from two small requests.
 *
 * Three hours of `time` and nothing else, near the start of the record and
 * near the end, and the smaller of the two is kept.
 *
 * Both ends, because a record's cadence changes: `oshenPD22` reports every
 * two minutes on 2026-08-07 and every ten on 2026-08-19, and probing only
 * the end concluded ten and then chose a rung too coarse to see the
 * two-minute half of the mission at all. The finest is the right one to size
 * the fetch by — asking for more resolution than exists costs nothing, and
 * asking for less loses it permanently.
 *
 * Measured rather than assumed per vendor for the same reason: the archive
 * disagrees with itself across eras and within single records.
 */
async function probeCadence(d) {
  const fallback = { saildrone: 60, oshen: 300, chance: 60 }[d.vendor] ?? 60;
  if (!Number.isFinite(d.end) || !Number.isFinite(d.start)) return fallback;

  const windows = [
    [d.end - 3 * 3600, d.end],
    [d.start, d.start + 3 * 3600],
  ];
  const measured = [];
  for (const [start, end] of windows) {
    try {
      /* `retries: 0`. A probe that fails is already handled — the vendor
         default is the fallback and it is close enough to size a fetch by.
         Retrying it costs two minutes per attempt on a dataset the server is
         refusing, which is four minutes of every build spent re-asking a
         question whose answer does not much matter. */
      const probe = await fetchTable(d.id, ['time'], { base: PMEL, start, end, retries: 0 });
      const c = medianCadence(probe.time);
      if (Number.isFinite(c) && c > 0) measured.push(c);
    } catch {
      /* An empty probe window is not a failure — the record may end before
         `maxTime` suggests, or simply have a gap there. */
    }
  }
  return measured.length ? Math.min(...measured) : fallback;
}

/**
 * Which columns to fetch, in priority order.
 *
 * Only `mean` statistics. The `_STDDEV`, `_MIN`, `_MAX` and `_PEAK`
 * companions roughly triple the column count for a spread nobody plots as a
 * series — they are the *scatter within* each reporting interval, not a
 * second measurement, and a record that carries them for every channel would
 * spend its whole column budget on them.
 */
function pickColumns(resolved) {
  const means = resolved.columns.filter((r) => r.statistic === 'mean');
  const named = means.filter((r) => r.quantity)
    .sort((a, b) => a.quantity.rank - b.quantity.rank
      || a.column.localeCompare(b.column));
  const unnamed = means.filter((r) => !r.quantity && !r.faults.length)
    .sort((a, b) => a.column.localeCompare(b.column));
  return [...named, ...unnamed].slice(0, MAX_COLUMNS);
}

/** The key a column is stored under. The canonical quantity where it is the
    primary measurement of one, and the vendor column otherwise — so a page
    can ask for `sea_temperature` on any vehicle and still reach the second
    thermometer by name. */
function seriesKey(r, resolved) {
  if (r.quantity && resolved.primary.get(r.quantity.key) === r) return r.quantity.key;
  return r.column;
}

/**
 * The quantities computed here.
 *
 * Each is skipped where its inputs are absent rather than filled with NaN:
 * an all-NaN column costs bytes, draws an empty figure and implies the
 * vehicle carried an instrument it did not.
 */
function deriveAll(primary, lat, lon, vendor, rows) {
  const out = new Map();
  const wind = primary.get('wind_speed');
  const heightColumn = primary.get('wind_height');
  const tAir = primary.get('air_temperature');
  const rh = primary.get('relative_humidity');
  const pressure = primary.get('air_pressure');
  const temp = primary.get('sea_temperature');
  const salt = primary.get('salinity');

  if (wind) {
    const u10 = new Float64Array(rows);
    const tau = new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
      /* The height is per record on a Saildrone, because the wing moves. */
      const z = heightColumn && Number.isFinite(heightColumn[i])
        ? heightColumn[i]
        : WIND_HEIGHT[vendor] ?? 3.4;
      const u = u10Neutral(wind[i], z);
      u10[i] = u;
      tau[i] = windStress(u);
    }
    out.set('u10', u10);
    out.set('wind_stress', tau);
  }

  if (tAir && rh) {
    const td = new Float64Array(rows);
    for (let i = 0; i < rows; i++) td[i] = dewpoint(tAir[i], rh[i]);
    out.set('dewpoint', td);
    if (pressure) {
      const q = new Float64Array(rows);
      for (let i = 0; i < rows; i++) q[i] = specificHumidity(tAir[i], rh[i], pressure[i]);
      out.set('specific_humidity', q);
    }
  }

  if (temp && salt) {
    const sa = new Float64Array(rows);
    const ct = new Float64Array(rows);
    const sigma0 = new Float64Array(rows);
    const spice0 = new Float64Array(rows);
    const c = new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
      const r = seawater(
        { salinity: salt[i], temperature: temp[i], lon: lon[i], lat: lat[i] }, atlas,
      );
      sa[i] = r.sa; ct[i] = r.ct; sigma0[i] = r.sigma0;
      spice0[i] = r.spice0; c[i] = r.soundSpeed;
    }
    out.set('sa', sa);
    out.set('ct', ct);
    out.set('sigma0', sigma0);
    out.set('spice0', spice0);
    out.set('sound_speed', c);
  }

  return out;
}

function countChecks(findings) {
  const out = {};
  for (const f of findings) out[f.check] = (out[f.check] ?? 0) + 1;
  return out;
}
