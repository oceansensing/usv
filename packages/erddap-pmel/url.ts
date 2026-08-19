/**
 * Building tabledap URLs.
 *
 * ERDDAP's query syntax is not a normal query string and cannot be built
 * with `URLSearchParams`. The variable list is the *whole* query before the
 * first `&`, unnamed and comma-separated, and each `&` after it is a
 * constraint written as an expression — `time>=2026-08-10T00:00:00Z` — where
 * the operator is part of the text rather than a separator.
 * `URLSearchParams` would percent-encode the commas and the `>=` into
 * something the server reads as one nonsense variable name, and then return
 * a 404 that looks like an empty dataset.
 *
 * So the parts are encoded by hand, and only where they must be.
 */

export const PMEL = 'https://data.pmel.noaa.gov/pmel/erddap' as const;

/** Percent-encode a constraint's value without touching the operator. */
const enc = (s: string): string =>
  s.replace(/[%"<>&#+ ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/** ERDDAP wants ISO 8601 with a trailing Z, to the second. */
export function isoTime(epochSeconds: number): string {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * Parse ERDDAP's time strings to epoch seconds.
 *
 * By hand rather than `Date.parse`, because this runs once per row and a
 * 226-day Saildrone record is 324,843 of them. The digits are read by
 * position for the two forms the server actually emits:
 *
 *     2026-08-14T00:01:00Z        Oshen, Chance, older Saildrone   (20 chars)
 *     2026-08-14T00:00:00.000Z    every 2026 Saildrone record      (24 chars)
 *
 * **The millisecond form is not an edge case here.** The sibling glider
 * client checks only for length 20 and falls through to `Date.parse` for
 * anything else — which on this archive is the fast path missing on the
 * largest datasets in it. Anything neither form still falls back rather than
 * being guessed at.
 */
export function parseIsoTime(s: string): number {
  const n = s.length;
  if ((n === 20 || n === 24) && s.charCodeAt(n - 1) === 90 /* Z */) {
    const y = +s.slice(0, 4);
    const mo = +s.slice(5, 7);
    const d = +s.slice(8, 10);
    const h = +s.slice(11, 13);
    const mi = +s.slice(14, 16);
    const sec = +s.slice(17, 19);
    if (y === y && mo === mo && d === d && h === h && mi === mi && sec === sec) {
      const ms = n === 24 ? +s.slice(20, 23) : 0;
      if (ms === ms) return Date.UTC(y, mo - 1, d, h, mi, sec, ms) / 1000;
    }
  }
  const t = Date.parse(s);
  return t === t ? t / 1000 : NaN;
}

export interface QueryOptions {
  /** Epoch seconds, inclusive. */
  start?: number;
  end?: number;
  /**
   * One row per interval of the time column, as an ERDDAP interval string:
   * `20minutes`, `1hour`, `6hours`.
   *
   * **This saves bytes and not server time** — measured at 12.9 s against
   * 12.8 s for sixty times fewer rows on the same dataset, because ERDDAP
   * applies it after the read. Use it to fit a transfer budget, never to
   * make a slow request fast.
   */
  every?: string;
  /** The time column, where a dataset does not call it `time`. */
  timeVar?: string;
  /** Extra constraints, already written as ERDDAP expressions. */
  extra?: string[];
}

/**
 * A tabledap URL. `format` is the extension: `csv`, `jsonlCSV`, `json`, `nc`.
 */
export function tabledapUrl(
  base: string,
  id: string,
  format: string,
  variables: readonly string[],
  opts: QueryOptions = {},
): string {
  const root = base.replace(/\/+$/, '');
  const time = opts.timeVar ?? 'time';
  const parts: string[] = [variables.join(',')];

  if (opts.start !== undefined && Number.isFinite(opts.start)) {
    parts.push(`${time}%3E=${isoTime(opts.start)}`);
  }
  if (opts.end !== undefined && Number.isFinite(opts.end)) {
    parts.push(`${time}%3C=${isoTime(opts.end)}`);
  }
  for (const c of opts.extra ?? []) parts.push(enc(c));

  /* Last, and it has to be: ERDDAP applies the orderBy after the
     constraints, and rejects the query outright if one follows it. */
  if (opts.every) parts.push(`orderByClosest(%22${time}/${opts.every}%22)`);

  return `${root}/tabledap/${id}.${format}?${parts.join('&')}`;
}

/** The `info/<id>/index.json` document. */
export function infoUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, '')}/info/${id}/index.json`;
}

/** The human-facing dataset page, for a "see it on PMEL" link. */
export function datasetPageUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, '')}/tabledap/${id}.html`;
}

/** The dataset's own metadata page, which is what a reader wanting the
    licence, the acknowledgement or the instrument list should be sent to. */
export function datasetInfoPageUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, '')}/info/${id}/index.html`;
}

/**
 * The catalog query.
 *
 * `allDatasets` is a real tabledap dataset with a row per active dataset, so
 * it takes constraints like any other. It does **not** take `page` or
 * `itemsPerPage` — those are the *web form's* parameters, and passing them
 * to tabledap is a 400. It also carries a row for itself, which
 * `listDatasets` drops.
 */
export function catalogUrl(base: string): string {
  const columns = [
    'datasetID', 'title', 'institution', 'cdm_data_type', 'class',
    'minTime', 'maxTime',
    'minLongitude', 'maxLongitude', 'minLatitude', 'maxLatitude',
  ];
  return `${base.replace(/\/+$/, '')}/tabledap/allDatasets.json?${columns.join(',')}`;
}

/**
 * ERDDAP's interval string for a number of minutes.
 *
 * Minutes below an hour, hours above, because `orderByClosest("time/90minutes")`
 * is accepted but `"time/1.5hours"` is not — the number must be an integer,
 * so the unit is chosen to make it one.
 */
export function intervalString(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) {
    const h = minutes / 60;
    return `${h}hour${h === 1 ? '' : 's'}`;
  }
  return `${minutes}minute${minutes === 1 ? '' : 's'}`;
}
