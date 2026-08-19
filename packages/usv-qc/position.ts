/**
 * The two checks about where the vehicle was.
 *
 * Position is the one field every page uses whether the reader asked for it
 * or not — the fleet map, the track, the colour axis, the campaign
 * comparison — so a fault in it is worth finding separately from the science.
 */

import type { Finding } from './types.ts';
import { MAX_MARKS } from './types.ts';
import { humanDuration, isoTime, sample } from './series.ts';

const EARTH_R = 6371008.8;

/** Great-circle distance in metres. */
export function haversine(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The speed a USV cannot exceed, in m/s.
 *
 * A Saildrone Explorer makes about 3 m/s downwind in a good breeze and an
 * Oshen rather less. Eight is far above anything any of them does and well
 * below what a bad fix produces, which is typically hundreds — a position
 * that jumps to the null island and back covers thousands of kilometres in a
 * minute.
 */
const MAX_SPEED = 8;

/**
 * Positions that are missing, impossible, or unreachable from the last one.
 *
 * Three separate faults reported as one finding each, because the fixes
 * differ:
 *
 * - **Missing**: latitude or longitude NaN while the row exists. Common in
 *   this archive and mostly harmless, except that
 *   `last(df.longitude)` is then NaN — which is exactly why the campaign
 *   analysis has a `last_fix()` helper and does not index the last row.
 * - **Null island**: exactly (0, 0), which is in the Gulf of Guinea and is
 *   what an uninitialised fix looks like. Reported separately from other
 *   impossible values because it is a specific and recognisable bug.
 * - **Unreachable**: a jump requiring a speed no USV achieves.
 */
export function position(
  time: Float64Array, lat: Float64Array, lon: Float64Array,
): Finding[] {
  const n = Math.min(time.length, lat.length, lon.length);
  if (n < 3) return [];
  const findings: Finding[] = [];

  const missing: number[] = [];
  const nullIsland: number[] = [];
  for (let i = 0; i < n; i++) {
    const la = lat[i];
    const lo = lon[i];
    if (!Number.isFinite(la) || !Number.isFinite(lo)) { missing.push(time[i]); continue; }
    if (la === 0 && lo === 0) nullIsland.push(time[i]);
  }

  if (missing.length) {
    const fraction = missing.length / n;
    findings.push({
      check: 'position',
      severity: fraction > 0.1 ? 'medium' : 'low',
      summary: `${missing.length} row${missing.length === 1 ? '' : 's'} with no position `
        + `(${(100 * fraction).toFixed(1)} % of the record)`,
      detail: 'The row exists and carries measurements; the fix does not. Mostly '
        + 'harmless for a track, which simply skips them — but it means the last row '
        + "of a record is not reliably the vehicle's last known position, and code "
        + 'that reads it as one gets NaN.',
      start: missing[0],
      end: missing[missing.length - 1],
      count: missing.length,
      marks: sample(missing, MAX_MARKS),
    });
  }

  if (nullIsland.length) {
    findings.push({
      check: 'position',
      severity: 'high',
      summary: `${nullIsland.length} fix${nullIsland.length === 1 ? '' : 'es'} at exactly `
        + '0°N 0°E',
      detail: 'The null island, in the Gulf of Guinea. No vehicle in this archive '
        + 'operates within thousands of kilometres of it, so this is an uninitialised '
        + 'or zeroed fix rather than a position. It is called out separately from other '
        + 'impossible values because it is a specific, recognisable bug — and because '
        + 'it drags a track across an ocean the vehicle never entered.',
      start: nullIsland[0],
      end: nullIsland[nullIsland.length - 1],
      count: nullIsland.length,
      marks: sample(nullIsland, MAX_MARKS),
    });
  }

  /* Jumps, measured between consecutive *valid* fixes, so a gap in the
     position does not itself look like a jump. */
  const jumps: number[] = [];
  let worstSpeed = 0;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) continue;
    if (lat[i] === 0 && lon[i] === 0) continue;
    if (prev >= 0) {
      const dt = time[i] - time[prev];
      if (dt > 0) {
        const speed = haversine(lat[prev], lon[prev], lat[i], lon[i]) / dt;
        if (speed > MAX_SPEED) {
          jumps.push(time[i]);
          worstSpeed = Math.max(worstSpeed, speed);
        }
      }
    }
    prev = i;
  }

  if (jumps.length) {
    findings.push({
      check: 'position',
      severity: 'medium',
      summary: `${jumps.length} position jump${jumps.length === 1 ? '' : 's'} requiring `
        + `more than ${MAX_SPEED} m/s, the worst ${worstSpeed.toFixed(0)} m/s`,
      detail: `A Saildrone Explorer makes about 3 m/s downwind in a good breeze and an `
        + `Oshen rather less, so ${MAX_SPEED} m/s is far above anything any of these `
        + 'vehicles does and far below what a bad fix produces. Measured between '
        + 'consecutive valid fixes, so a gap in the position record does not itself '
        + 'register as a jump.',
      start: jumps[0],
      end: jumps[jumps.length - 1],
      count: jumps.length,
      marks: sample(jumps, MAX_MARKS),
    });
  }

  return findings;
}

/**
 * A record that has stopped reporting while its mission is notionally
 * running.
 *
 * `now` is a parameter rather than a call to the clock so that the tests are
 * not a function of when they run, and so that a build states the time it
 * asked about.
 *
 * The threshold is generous — 24 hours rather than the six that marks a
 * vehicle inactive on the fleet map — because this is a *finding* on a
 * record rather than a badge. PD15 in August 2026 is the case: silent from
 * the 15th, having turned back toward St. Thomas, and most likely recovered
 * rather than lost.
 */
export function silent(
  lastReport: number, now: number,
  options: { hours?: number; archivedAfterDays?: number } = {},
): Finding[] {
  const limit = (options.hours ?? 24) * 3600;
  const quiet = now - lastReport;
  if (!(quiet > limit)) return [];
  /* **A record that ended eight months ago is archived, not silent.** The
     first build reported "no report for 202.4 days" on every historic record
     in the archive — 130-odd findings that are all the same fact, that the
     mission is over, and that push the live ones off the page. Beyond the
     window this is not a finding at all; the catalog already shows the end
     date. */
  const archived = (options.archivedAfterDays ?? 30) * 86400;
  if (quiet > archived) return [];
  return [{
    check: 'silent',
    severity: quiet > 7 * 86400 ? 'medium' : 'low',
    summary: `no report for ${humanDuration(quiet)}, since ${isoTime(lastReport)}`,
    detail: 'Measured against when this site last fetched the record, which is printed '
      + 'on the page. A vehicle can go quiet because it was recovered, because its '
      + 'link failed, or because the mission ended and the dataset was not retired — '
      + 'this cannot tell those apart and does not try to.',
    start: lastReport,
    end: now,
  }];
}
