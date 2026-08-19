/**
 * Reading what the build wrote.
 *
 * Two files and no network beyond this origin. The catalog is one request
 * shared by every page; a series is one request made only when a reader
 * opens that vehicle.
 *
 * **There is no fallback path and there should not be.** The sibling glider
 * site fetches the IOOS DAC live and keeps a committed snapshot for when that
 * fails; here the snapshot *is* the data, served from the same origin as the
 * page that asks for it, so a failure is the site being broken rather than an
 * upstream having a bad morning.
 */

import { DATA } from '../config.ts';
import { withBase } from './url.ts';
import type { SeriesVariable } from './variables.ts';

/* -------------------------------------------------------------- catalog -- */

export interface Finding {
  check: string;
  severity: 'high' | 'medium' | 'low' | 'note';
  quantity?: string;
  column?: string;
  summary: string;
  detail?: string;
  start?: number;
  end?: number;
  count?: number;
  marks?: number[];
}

export interface CatalogEntry {
  id: string;
  title: string;
  institution: string;
  vendor: 'saildrone' | 'oshen' | 'chance';
  kind: 'trajectory' | 'collection' | 'derived' | 'files';
  vehicle: string;
  /** True where the record's rows come from several vehicles interleaved, so
      its track is a scribble no vehicle sailed. See `DatasetSummary`. */
  multiVehicle: boolean;
  campaign: string;
  campaignLabel: string;
  variant: string;
  summary: string;
  start: number;
  end: number;
  west: number;
  east: number;
  south: number;
  north: number;
  quantities: string[];
  variables: number;
  attributes: Record<string, string>;
  /* Written by `build-series.mjs`, so absent on a record whose series failed
     to build — which the fleet page shows as "not built" rather than as
     "no findings". */
  rows?: number;
  cadenceSeconds?: number;
  resolutionSeconds?: number;
  severity?: 'high' | 'medium' | 'low' | 'note' | null;
  findings?: number;
  checks?: Record<string, number>;
  seriesFetched?: number;
}

export interface Campaign {
  slug: string;
  label: string;
  vendors: string[];
  datasets: string[];
  start: number | null;
  end: number | null;
}

export interface Catalog {
  fetched: number;
  seriesBuilt?: number;
  source: string;
  datasets: CatalogEntry[];
  campaigns: Campaign[];
  unknownUnits: string[];
}

let catalogPromise: Promise<Catalog> | undefined;

/**
 * When the data on this site was fetched, in epoch seconds.
 *
 * **Every "is it reporting" question is asked against this, not against the
 * clock**, and that is the difference between a number that means something
 * and one that decays to zero. See `isActive`.
 */
let fetchedAt = NaN;

/** The catalog, fetched once per page load however many callers ask. */
export function loadCatalog(): Promise<Catalog> {
  catalogPromise ??= fetch(withBase(DATA.catalog)).then((r) => {
    if (!r.ok) throw new Error(`catalog: ${r.status} ${r.statusText}`);
    return r.json() as Promise<Catalog>;
  }).then((catalog: Catalog) => {
    fetchedAt = catalog.seriesBuilt ?? catalog.fetched;
    return catalog;
  });
  return catalogPromise;
}

/** When this site's data was fetched. NaN before the catalog has loaded. */
export function dataFetchedAt(): number {
  return fetchedAt;
}

/* --------------------------------------------------------------- series -- */

export interface SeriesDoc {
  id: string;
  title: string;
  vendor: string;
  vehicle: string;
  /** Written by builds from 2026-08-19 on. Older series files predate it, so
      the vehicle page takes the catalog's value, which is always current. */
  multiVehicle?: boolean;
  campaign: string;
  campaignLabel: string;
  institution: string;
  attributes: Record<string, string>;
  fetched: number;
  source: string;
  resolutionSeconds: number;
  cadenceSeconds: number;
  seriesCadenceSeconds: number;
  fetchedRows: number;
  rows: number;
  decimated: boolean;
  anomalyApplied: boolean;
  time: Array<number | null>;
  lat: Array<number | null>;
  lon: Array<number | null>;
  variables: SeriesVariable[];
  columns: Record<string, Array<number | null>>;
  qc: {
    findings: Finding[];
    resolutionSeconds: number;
    cadenceSeconds: number;
    rows: number;
    fetched: number;
  };
  qcNote: string;
}

/** Everything below the fetch works in `Float64Array`, with NaN for missing.
 *  One container for the whole page means no figure has to ask what kind of
 *  column it was handed, and NaN is what the plot engine already skips. */
export interface Series {
  doc: SeriesDoc;
  columns: Map<string, Float64Array>;
  rows: number;
}

const seriesCache = new Map<string, Promise<Series>>();

export function loadSeries(id: string): Promise<Series> {
  let hit = seriesCache.get(id);
  if (!hit) {
    hit = fetch(`${withBase(DATA.series)}/${encodeURIComponent(id)}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`${id}: ${r.status} ${r.statusText}`);
        return r.json() as Promise<SeriesDoc>;
      })
      .then(toSeries);
    seriesCache.set(id, hit);
  }
  return hit;
}

/**
 * JSON arrays to typed arrays.
 *
 * `null` becomes NaN and **never zero**: an empty slot drawn as zero puts a
 * line through 0 °C where a record simply has a gap, which is the single
 * most misleading thing a plot of this data can do.
 */
function toSeries(doc: SeriesDoc): Series {
  const columns = new Map<string, Float64Array>();
  const rows = doc.rows;

  const convert = (values: Array<number | null>): Float64Array => {
    const out = new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
      const v = values[i];
      out[i] = v === null || v === undefined ? NaN : v;
    }
    return out;
  };

  columns.set('time', convert(doc.time));
  columns.set('lat', convert(doc.lat));
  columns.set('lon', convert(doc.lon));
  for (const [key, values] of Object.entries(doc.columns)) {
    columns.set(key, convert(values));
  }
  return { doc, columns, rows };
}

/* ---------------------------------------------------------------- detail -- */

/** One record's entry in a season shard's index. */
export interface DetailRecord {
  id: string;
  vehicle: string;
  campaign: string;
  rows: number;
  cadenceSeconds: number;
  /** Which chunks exist. Asked before any is fetched — a 404 for a week the
      vehicle was not reporting is indistinguishable in a browser from the
      shard being down. */
  chunks: number[];
  variables: string[];
  fetched: number;
}

export interface SeasonIndex {
  shard: string;
  season: string;
  built: number;
  source: string;
  records: DetailRecord[];
}

const seasonCache = new Map<string, Promise<SeasonIndex | null>>();

/**
 * A season shard's index, or null where the shard is not published.
 *
 * Null rather than a throw: a season whose shard does not exist yet is the
 * ordinary state of this site while the archive is backfilled, and the page
 * has an overview to show either way. It says full rate is unavailable
 * rather than showing an error.
 */
export function loadSeason(shard: string): Promise<SeasonIndex | null> {
  let hit = seasonCache.get(shard);
  if (!hit) {
    hit = fetch(`${withBase('/')}../${shard}/season.json`)
      .then((r) => (r.ok ? r.json() as Promise<SeasonIndex> : null))
      .catch(() => null);
    seasonCache.set(shard, hit);
  }
  return hit;
}

export interface Chunk {
  id: string;
  chunk: number;
  from: number;
  to: number;
  rows: number;
  time: Array<number | null>;
  lat: Array<number | null>;
  lon: Array<number | null>;
  columns: Record<string, Array<number | null>>;
}

const chunkCache = new Map<string, Promise<Chunk>>();

/**
 * Whether this browser can read the detail tier at all.
 *
 * The chunks are stored already compressed, because a static host does not
 * compress a file type it does not recognise and the archive only fits under
 * the 1 GB limit gzipped. Inflating them needs `DecompressionStream`, which
 * every current browser has and some older ones do not — so the page asks
 * before offering full rate, rather than failing at the moment a reader
 * clicks.
 */
export function canReadDetail(): boolean {
  return typeof DecompressionStream === 'function';
}

/** One week of one record, at the rate the instruments reported. */
export function loadChunk(shard: string, id: string, chunk: number): Promise<Chunk> {
  const key = `${shard}/${id}/${chunk}`;
  let hit = chunkCache.get(key);
  if (!hit) {
    hit = (async () => {
      const url = `${withBase('/')}../${shard}/${encodeURIComponent(id)}/${chunk}.json.gz`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${id} chunk ${chunk}: ${response.status}`);
      if (!canReadDetail()) throw new Error('this browser cannot inflate the detail tier');
      /* The host serves these under `application/gzip` and does not decode
         them, verified against the live site — so the bytes that arrive are
         the bytes that were written, and this is what turns them back into
         JSON. */
      const stream = response.body!.pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).json() as Chunk;
    })();
    chunkCache.set(key, hit);
  }
  return hit;
}

/**
 * Several chunks, stitched into the same column shape a `Series` carries.
 *
 * Ordered by chunk, and rows within a chunk are left in the order the record
 * published them — three Oshen records step backwards in time between
 * consecutive rows, and reordering them here would hide that from the
 * quality report rather than from the reader.
 */
export function stitch(chunks: readonly Chunk[]): {
  rows: number; columns: Map<string, Float64Array>;
} {
  const ordered = [...chunks].sort((a, b) => a.chunk - b.chunk);
  const rows = ordered.reduce((n, c) => n + c.rows, 0);
  const names = new Set<string>(['time', 'lat', 'lon']);
  for (const c of ordered) for (const k of Object.keys(c.columns)) names.add(k);

  const columns = new Map<string, Float64Array>();
  for (const name of names) {
    const out = new Float64Array(rows);
    let at = 0;
    for (const c of ordered) {
      const src = name === 'time' ? c.time
        : name === 'lat' ? c.lat
          : name === 'lon' ? c.lon
            : c.columns[name];
      for (let i = 0; i < c.rows; i++) {
        const v = src?.[i];
        out[at++] = v === null || v === undefined ? NaN : v;
      }
    }
    columns.set(name, out);
  }
  return { rows, columns };
}

/* ---------------------------------------------------------------- dates -- */

/** `2026-08-14`. The clock is not shown where a day is the question. */
export function isoDay(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '—';
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** `2026-08-14 09:31Z`. Always UTC, always marked as such: every timestamp
    in this archive is UTC and a reader's local time would be a different
    fact silently substituted. */
export function isoMinute(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '—';
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** "3 days ago", "11 hours ago". For an age, where the exact instant is
    less use than the distance from now. */
export function since(epochSeconds: number, now = Date.now() / 1000): string {
  const d = now - epochSeconds;
  if (!Number.isFinite(d)) return '—';
  if (d < 90 * 60) return `${Math.round(d / 60)} min ago`;
  if (d < 48 * 3600) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
}

/** A span, written the way a mission length is spoken. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)} h`;
  return `${Math.round(seconds / 86400)} days`;
}

/**
 * Whether a record was reporting **when this site last fetched it**.
 *
 * Six hours is the threshold, because every active mission in this archive
 * reports at least every five minutes.
 *
 * **Measured against the fetch, not against the clock**, and that is the
 * whole point. The data here is a snapshot rebuilt every six hours, so a
 * vehicle reporting perfectly is up to six hours stale by the end of a
 * cycle — and asked against the wall clock, the count of live vehicles falls
 * to zero shortly before every rebuild and jumps back afterwards. Measured
 * an hour and a half after one build, "reporting" had already dropped from
 * 21 to 2 while nothing at sea had changed.
 *
 * "Was it reporting when we looked" is the question a snapshot can answer.
 * The pages print how long ago that was, which is what makes the answer
 * usable.
 */
export function isActive(entry: CatalogEntry, reference = fetchedAt): boolean {
  if (!Number.isFinite(reference)) return false;
  return Number.isFinite(entry.end) && reference - entry.end < 6 * 3600;
}
