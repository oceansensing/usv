/**
 * Running every check over one record.
 *
 * The order of the calls does not matter and no check reads another's
 * output. What this file actually decides is **which checks apply to which
 * column**, and that is where most of the false positives were.
 */

import type { DatasetInfo, Vendor } from '@c4po/erddap-pmel';
import type { ResolvedDataset } from '@c4po/usv-vars';
import type { Check, Finding, Report } from './types.ts';
import { rank } from './types.ts';
import {
  cadence, timeOrder, dropout, gaps, range, reportingInterval, spikes, stuck,
} from './series.ts';
import { directionConvention } from './series.ts';
import { position, silent } from './position.ts';
import {
  attribution, columnMetadata, humidityUnits, unresolvedColumns, windHeight,
} from './metadata.ts';

export interface RunInput {
  info: DatasetInfo;
  resolved: ResolvedDataset;
  vendor: Vendor;
  /** Epoch seconds. */
  time: Float64Array;
  /** Canonical quantity key → converted values, aligned to `time`. */
  columns: Map<string, Float64Array>;
  lat: Float64Array;
  lon: Float64Array;
  /** The interval the fetch actually ran at, in seconds. */
  resolutionSeconds: number;
  /**
   * The spacing of the rows handed in, in seconds.
   *
   * **Not the vehicle's rate** where the fetch was decimated — it is the rate
   * of the data in hand, which is what `gaps` and the sparse-column test have
   * to judge against. A gap is a gap relative to the samples either side of
   * it, not relative to a rate nothing here was sampled at.
   */
  cadenceSeconds: number;
  /**
   * The vehicle's own reporting interval, in seconds, probed before any
   * decimation.
   *
   * Kept apart from `cadenceSeconds` because the two are equal only when the
   * fetch ran at full rate, and **the one question that needs the difference
   * is the only one that was asking the wrong field**: whether the checks
   * could have seen a single-sample artifact. See `coverageNote`.
   */
  nativeCadenceSeconds: number;
  /** Epoch seconds this build fetched the record. */
  fetched: number;
  /** True where the record's rows come from several vehicles interleaved. A
      few checks are meaningless on one — see `timeOrder`. */
  multiVehicle?: boolean;
}

/**
 * Quantities no spike or stuck test is run on.
 *
 * **A bearing crossing north steps by 359° and back**, which is precisely the
 * shape `spikes` looks for and is not a fault. Nothing here understands
 * circular quantities, so rather than pretend, they are excluded and the
 * exclusion is visible.
 *
 * A vehicle at station legitimately holds a heading, and a wind sensor in a
 * calm legitimately holds a direction, so `stuck` is wrong on them too.
 */
const CIRCULAR = new Set([
  'wind_direction', 'course_over_ground', 'heading', 'wing_heading',
  'current_direction',
]);

/**
 * Quantities `stuck` is not run on even though they are not circular.
 *
 * A radiometer reads exactly zero all night, every night, and a PAR sensor
 * does the same. That is the instrument working.
 */
const RESTS_AT_ZERO = new Set([
  'par', 'shortwave_down', 'shortwave_diffuse', 'wave_height',
]);

export function run(input: RunInput): Report {
  const {
    info, resolved, vendor, time, columns, lat, lon,
    resolutionSeconds, cadenceSeconds, nativeCadenceSeconds, fetched,
    multiVehicle = false,
  } = input;

  const findings: Finding[] = [];

  /* Whether the mission is over. A month, matching `silent` — the same
     threshold, because it is the same question: is this a record somebody is
     still flying, or one that has been put away. */
  const lastReport = time.length ? time[time.length - 1] : NaN;
  const archived = Number.isFinite(lastReport)
    && fetched - lastReport > 30 * 86400;

  /* -- the record as a whole ------------------------------------------- */
  findings.push(...gaps(time, cadenceSeconds));
  findings.push(...cadence(time));
  /* **Not on an interleaved record.** Several vehicles reporting into one
     table step backwards constantly and correctly; the record already
     carries its own explanation and its track is already suppressed. */
  if (!multiVehicle) findings.push(...timeOrder(time));
  findings.push(...position(time, lat, lon));
  if (time.length) findings.push(...silent(time[time.length - 1], fetched));

  /* -- each quantity --------------------------------------------------- */
  for (const [key, values] of columns) {
    const r = resolved.primary.get(key);
    const units = r?.quantity?.units ?? '';

    findings.push(...range(time, values, key, units));

    if (CIRCULAR.has(key)) {
      findings.push(...directionConvention(values, key));
    } else {
      findings.push(...spikes(time, values, key, units));
      if (!RESTS_AT_ZERO.has(key)) findings.push(...stuck(time, values, key, units));
    }

    /* **Sparse is not missing.** A Saildrone's SBE37 reports every five
       minutes into a one-minute record — 80 % of rows empty and a perfectly
       healthy instrument. `dropout` compares against the row count, so it is
       only asked when the column's own reporting interval is close to the
       vehicle's. Where it is not, the column is sparse by design and the
       only dropout worth reporting is the one at the end of the record,
       which `dropout` finds from the trailing window regardless. */
    const own = reportingInterval(time, values);
    const sparse = Number.isFinite(own) && own > cadenceSeconds * 1.5;
    for (const f of dropout(time, values, key, { archived })) {
      if (sparse && f.severity === 'medium') continue;
      findings.push(f);
    }
  }

  /* -- the metadata ---------------------------------------------------- */
  findings.push(...columnMetadata(resolved.columns));
  findings.push(...attribution(info));
  findings.push(...unresolvedColumns(resolved.columns));

  const rh = resolved.primary.get('relative_humidity');
  const rhValues = columns.get('relative_humidity');
  if (rh && rhValues) findings.push(...humidityUnits(rhValues, rh));

  findings.push(...windHeight(
    vendor,
    resolved.primary.has('wind_height'),
    resolved.primary.has('wind_speed'),
  ));

  return {
    findings: rank(mergeSimultaneousDropouts(findings)),
    resolutionSeconds,
    cadenceSeconds: nativeCadenceSeconds,
    sampledCadenceSeconds: cadenceSeconds,
    rows: time.length,
    fetched,
  };
}

/**
 * Sensors that died together are one event, not twelve.
 *
 * A Chance record whose science payload stopped on 2026-01-27 produced nine
 * separate "no data since 2026-01-27" findings, one per column, filling the
 * top of the report with the same fact. When a payload loses power, or a
 * mission's science phase ends, every instrument on it stops in the same
 * minute — and a reader needs to see that as one thing that happened.
 *
 * Grouped by the **day** rather than the exact second: instruments in one
 * payload stop within minutes of each other, not simultaneously, and a
 * second-exact grouping would split the very event it exists to join.
 * Anything that stopped on its own day keeps its own finding.
 */
export function mergeSimultaneousDropouts(findings: readonly Finding[]): Finding[] {
  /* Grouped by severity as well as by day: a mission's payload shutting
     down and a live vehicle's sensor failing are different events and must
     not be merged into one finding that has to pick a severity for both. */
  const dead = findings.filter(
    (f) => f.check === 'dropout' && f.quantity && f.start
      && (f.severity === 'high' || f.severity === 'medium' || f.severity === 'low')
      && /^no data since/.test(f.summary),
  );
  if (dead.length < 3) return [...findings];

  const byDay = new Map<string, Finding[]>();
  for (const f of dead) {
    const day = `${f.severity}@${new Date(f.start! * 1000).toISOString().slice(0, 10)}`;
    const group = byDay.get(day) ?? [];
    group.push(f);
    byDay.set(day, group);
  }

  const merged: Finding[] = [];
  const consumed = new Set<Finding>();
  for (const [key, group] of byDay) {
    if (group.length < 3) continue;
    const day = key.split('@')[1];
    for (const f of group) consumed.add(f);
    const names = group.map((f) => f.quantity!).sort();
    merged.push({
      check: 'dropout',
      severity: group[0].severity,
      summary: `${group.length} instruments stopped together on ${day}, while the `
        + 'vehicle kept reporting',
      detail: `${names.join(', ')}. Grouped because they stopped within the same day: `
        + 'when a payload loses power or a mission\'s science phase ends, every '
        + 'instrument on it stops at once, and that is one event rather than '
        + `${group.length}. Each column is still empty from this date to the end of `
        + 'the record.',
      start: Math.min(...group.map((f) => f.start!)),
      end: Math.max(...group.map((f) => f.end ?? f.start!)),
      count: group.length,
    });
  }

  return [...findings.filter((f) => !consumed.has(f)), ...merged];
}

/** A one-line count per check, for a badge row. */
export function tally(findings: readonly Finding[]): Record<Check, number> {
  const out = {
    gap: 0, spike: 0, stuck: 0, range: 0, dropout: 0, cadence: 0,
    position: 0, metadata: 0, silent: 0, timeorder: 0,
  };
  for (const f of findings) out[f.check]++;
  return out;
}

/**
 * What a check could not have found, said plainly.
 *
 * A quality report that does not state its own resolution implies it looked
 * at everything. The long archive records are checked at five minutes, and a
 * one-minute spike in a 2021 record was never looked for — that has to be on
 * the page, not in a commit message.
 */
export function coverageNote(report: Report): string {
  const { resolutionSeconds, cadenceSeconds } = report;
  if (!(cadenceSeconds > 0)) return 'The vehicle\'s reporting interval could not be measured.';
  /* **Against the vehicle's rate, not the sampled one.** Compared with the
     spacing of the rows the checks were handed, this is true by construction
     — decimated data is exactly as coarse as the decimation asked for — so
     the coarse branch below could never fire, and 46 of the archive's 152
     records told a reader their one-minute artifacts had been looked for
     when the checks ran at two or five minutes. */
  const native = resolutionSeconds <= cadenceSeconds * 1.01;
  if (native) {
    return 'These checks ran at the rate the vehicle reported, so a single-sample '
      + 'artifact is visible to them.';
  }
  return `These checks ran at ${interval(resolutionSeconds)} resolution `
    + `against a vehicle reporting every ${interval(cadenceSeconds)}, `
    + 'because the whole record at full rate is past this build\'s fetch budget. '
    + 'A single-sample artifact finer than that was not looked for.';
}

/** A reporting interval, written the way it is spoken — and never "every 1
    minutes", which is what rounding to whole minutes used to produce on the
    one-minute records that are most of this archive. */
function interval(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const m = seconds / 60;
  return m === 1 ? 'minute' : `${Number.isInteger(m) ? m : m.toFixed(1)} minutes`;
}
