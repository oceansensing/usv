/**
 * Getting rows out of PMEL.
 *
 * This runs **under Node, at build time**, and that is not an implementation
 * detail — `data.pmel.noaa.gov` sends no `Access-Control-Allow-Origin`
 * header on any response, so none of it can run in a browser. The site reads
 * what `scripts/build-series.mjs` wrote with it.
 *
 * Which removes the constraint the sibling glider client is built around.
 * There, a reader is watching a blank page, so the fetch is chunked to paint
 * something inside a second and the chunk planner is most of the module.
 * Here nobody is waiting: a build can spend twenty seconds on one request,
 * and one request is *cheaper* than five because ERDDAP's cost is dominated
 * by the scan, not the transfer. So there is no chunking, and the two levers
 * that remain are the ones that were measured to matter — **which columns**,
 * and **how finely**.
 */

import type { Resolution, TableData } from './types.ts';
import { parseJsonlCsvStream } from './parse.ts';
import { intervalString, PMEL, type QueryOptions, tabledapUrl } from './url.ts';

/**
 * The decimation ladder, in minutes.
 *
 * **Every rung above 2 divides by 5, and that is the whole design.** A
 * Saildrone's SBE37 reports every five minutes into a one-minute record, so
 * 80.2 % of full-rate rows carry no sea temperature. `orderByClosest` picks
 * the row nearest each interval boundary, so an interval that is a multiple
 * of the sensor's own period lands *on* the reporting rows and one that is
 * not lands between them. Measured on `sd1030_hurricane_2026`, same 5-day
 * window: sea temperature is 80.2 % missing at full rate and **0.8 % missing
 * at `time/20minutes`**. A rung of 7 or 25 minutes would quietly return a
 * mostly-empty CTD record with nothing on screen to say why.
 */
export const LADDER = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360] as const;

/** How many rows a fetch is willing to bring back, before decimation to the
    display budget. Sized so the longest record in the archive — 431 days —
    still lands on a five-minute rung, which is fine enough for every QC
    check that matters to find what it is looking for. */
export const FETCH_ROWS = 150_000;

/** How many points a series is stored at. At 1240 px that is six per pixel,
    past where a finer series changes the picture, and it bounds the whole
    archive at about 200 MB rather than the 2 GB full rate would need. */
export const DISPLAY_POINTS = 8_000;

/**
 * A request that failed, and whether the failure was one.
 *
 * The fields are declared and assigned rather than written as constructor
 * parameter properties: the test suites run under `node
 * --experimental-strip-types` against these sources directly, and strip-only
 * mode rejects a parameter property outright — it is the one TypeScript
 * shorthand that needs a code transform rather than a deletion. The same
 * rule applies to `enum` and to namespaces; none of them appear here.
 */
export class ErddapError extends Error {
  readonly status: number;
  /** True for the 404 that means "no rows matched", which is not a failure:
      a vehicle on the surface or a day of no telemetry produces one, and
      treating it as a transport error reports a whole record as broken. */
  readonly empty: boolean;

  constructor(message: string, status: number, empty: boolean) {
    super(message);
    this.name = 'ErddapError';
    this.status = status;
    this.empty = empty;
  }
}

/**
 * The finest rung of the ladder that keeps a record under `budget` rows.
 *
 * `cadenceSeconds` is the vehicle's own reporting interval — one minute for
 * a Saildrone or a Chance, two to five for an Oshen. Asking for a rung finer
 * than the vehicle reports returns nothing extra and costs the same, so the
 * ladder starts at the cadence rather than at 1.
 */
export function chooseRung(
  spanSeconds: number, cadenceSeconds: number, budget = FETCH_ROWS,
): number {
  const floor = Math.max(1, Math.round(cadenceSeconds / 60));
  for (const minutes of LADDER) {
    if (minutes < floor) continue;
    if (spanSeconds / (minutes * 60) <= budget) return minutes;
  }
  return LADDER[LADDER.length - 1];
}

/**
 * Whether a rung is finer than the vehicle's own cadence, in which case it
 * is not decimation at all and the query should omit `orderByClosest`
 * entirely.
 *
 * Worth doing rather than harmless: an `orderByClosest` on a record already
 * coarser than the interval still makes ERDDAP do the grouping pass, and it
 * introduces the boundary-alignment question for nothing.
 */
export function isFullRate(minutes: number, cadenceSeconds: number): boolean {
  return minutes * 60 <= cadenceSeconds;
}

export interface FetchOptions extends QueryOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  /** The rung, in minutes. Omit for full rate. */
  minutes?: number;
  /** The vehicle's reporting interval, so a rung finer than it is dropped. */
  cadenceSeconds?: number;
  onRows?: (rows: number) => void;
  /** How many times to retry a request that failed for a reason that is not
      "no rows". PMEL's cold-cache responses reach 60 s and occasionally
      time out; a retry is much cheaper than losing the dataset. */
  retries?: number;
}

/**
 * One request, one table.
 *
 * The variable list must name `time` first; `TableData.time` is that column
 * and every check downstream assumes it is sorted and present.
 */
export async function fetchTable(
  id: string,
  variables: readonly string[],
  opts: FetchOptions = {},
): Promise<TableData> {
  const base = opts.base ?? PMEL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;

  const decimate = opts.minutes !== undefined
    && !isFullRate(opts.minutes, opts.cadenceSeconds ?? 0);
  const resolution: Resolution = decimate
    ? { kind: 'decimated', minutes: opts.minutes }
    : { kind: 'full' };

  const url = tabledapUrl(base, id, 'jsonlCSV', variables, {
    start: opts.start,
    end: opts.end,
    extra: opts.extra,
    timeVar: opts.timeVar,
    every: decimate ? intervalString(opts.minutes!) : undefined,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        const empty = response.status === 404;
        throw new ErddapError(
          `${id}: ${response.status} ${response.statusText}`
          + (response.status === 408
            ? ' — the server was still busy with another request from this client'
            : ''),
          response.status, empty,
        );
      }
      const parsed = await parseJsonlCsvStream(response, {
        names: variables,
        timeColumns: new Set([opts.timeVar ?? 'time']),
        onRows: opts.onRows,
      });
      const time = parsed.columns.get(opts.timeVar ?? 'time') ?? new Float64Array(0);
      return {
        rows: parsed.rows,
        columns: parsed.columns,
        time,
        resolution,
        partial: false,
      };
    } catch (error) {
      /* An empty result is an answer, not a failure. Retrying it would ask
         the same question and get the same 404 three times. */
      if (error instanceof ErddapError && error.empty) throw error;
      lastError = error;
      if (attempt < retries) {
        /* **A 408 here means the server is busy with this client's *other*
           request, not that the query is too large.** ERDDAP's message is
           explicit: "Timeout waiting for your other requests to process.
           Please make just one request at a time." Retrying immediately
           just joins the same queue, so it gets a much longer backoff —
           and `build-series.mjs` runs one request at a time for the same
           reason. */
        const busy = error instanceof ErddapError && error.status === 408;
        await sleep((busy ? 20_000 : 1500) * (attempt + 1));
      }
    }
  }
  throw lastError;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The vehicle's reporting interval, taken from the record itself.
 *
 * The **median** of the time differences rather than the mean or the
 * minimum: an Oshen's cadence varies from two to five minutes with the link,
 * a Saildrone occasionally emits two rows in the same minute, and every
 * record has gaps of hours. The median is the only one of the three that
 * describes what the vehicle normally does.
 *
 * Sampled rather than fully sorted — this runs over 325,000-row records and
 * a median is settled long before the last sample.
 */
export function medianCadence(time: Float64Array): number {
  const n = time.length;
  if (n < 3) return NaN;
  const stride = Math.max(1, Math.floor(n / 20_000));
  const deltas: number[] = [];
  for (let i = stride; i < n; i += stride) {
    const d = (time[i] - time[i - stride]) / stride;
    if (d > 0 && Number.isFinite(d)) deltas.push(d);
  }
  if (!deltas.length) return NaN;
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1];
}
