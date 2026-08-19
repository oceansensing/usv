/**
 * Where a track has to be cut, because the vehicle did not sail that bit.
 *
 * A polyline through every fix a record carries draws a straight line across
 * whatever lies between two consecutive fixes — and on this archive that is
 * sometimes a continent. **Three 2024 Saildrones were recovered in the
 * Atlantic and their records continue with dock telemetry from Alameda**, so
 * the last drawn segment of `sd1042_hurricane_2024` runs 4,055 km from off
 * Cape Hatteras to 37.8 °N 122.3 °W — San Francisco Bay — over twenty days.
 * Drawn joined up, it crosses the United States.
 *
 * The vehicle was on a ship. Nothing in the file says so, and nothing needs
 * to: **the question a track has to answer before it draws a line is whether
 * the vehicle could have got there**, and there are three ways the answer is
 * no.
 *
 * 1. **Too fast.** A Saildrone Explorer makes about 3 m/s downwind and an
 *    Oshen rather less. Eight is far above anything any of them does and far
 *    below a shipping leg or a bad fix.
 * 2. **Too long a silence.** A step can be slow enough to be sailable and
 *    still be a fabrication: `sd1040_hurricane_2024` covers 947 km in 86
 *    days, which is 0.13 m/s and perfectly reachable — but the vehicle
 *    reported nothing for those 86 days, so the line between is invention
 *    rather than observation. Measured against the *drawn* spacing, because
 *    a track is subsampled before it is drawn and the honest comparison is
 *    with its neighbours rather than with the vehicle's raw cadence.
 * 3. **Backwards.** Three Oshen records step backwards in time between
 *    consecutive rows. Whatever that is, it is not a course.
 *
 * The cut is a *drawing* decision and touches nothing else: every fix is
 * still a point on the map, still in the data, still exported. What changes
 * is that the pen lifts between them.
 */

import { haversine } from '@c4po/usv-qc';

/**
 * The speed above which a step is not something a USV did.
 *
 * The same constant `@c4po/usv-qc`'s position check uses, and deliberately
 * so: a leap the quality report calls impossible and the map draws anyway
 * would be the site contradicting itself on one screen.
 */
export const MAX_SPEED = 8;

/** How many times the usual spacing a gap may reach before the line is cut. */
export const GAP_FACTOR = 6;

export interface Fix {
  lat: number;
  lon: number;
  /** Epoch seconds. */
  t: number;
}

/**
 * The median interval between consecutive fixes, which is what a gap is
 * judged against.
 *
 * The median rather than the mean, for the usual reason: the gaps this
 * exists to find would set the threshold that is meant to catch them.
 */
export function typicalGap(fixes: readonly Fix[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < fixes.length; i++) {
    const dt = fixes[i].t - fixes[i - 1].t;
    if (dt > 0) deltas.push(dt);
  }
  if (!deltas.length) return NaN;
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1];
}

/** Whether a line may be drawn from `a` to `b`. */
export function reachable(a: Fix, b: Fix, typical: number): boolean {
  const dt = b.t - a.t;
  /* Not forwards in time: not a course. Equal stamps are two readings of one
     moment, which is fine to join. */
  if (dt < 0) return false;
  if (Number.isFinite(typical) && typical > 0 && dt > GAP_FACTOR * typical) return false;
  if (dt <= 0) return true;
  return haversine(a.lat, a.lon, b.lat, b.lon) / dt <= MAX_SPEED;
}

/**
 * Split a list of fixes into the runs that may be drawn as continuous lines.
 *
 * Returns runs of at least two fixes; a fix stranded between two cuts is
 * dropped from the *line* and is still drawn as a point by the caller if it
 * wants one. Single-fix runs are not returned because a polyline of one
 * point is nothing.
 */
export function reachableRuns(fixes: readonly Fix[]): Fix[][] {
  if (fixes.length < 2) return [];
  const typical = typicalGap(fixes);
  const runs: Fix[][] = [];
  let run: Fix[] = [fixes[0]];
  for (let i = 1; i < fixes.length; i++) {
    if (reachable(fixes[i - 1], fixes[i], typical)) {
      run.push(fixes[i]);
    } else {
      if (run.length >= 2) runs.push(run);
      run = [fixes[i]];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** How many cuts a set of fixes needs, for a caption that says so. */
export function cutCount(fixes: readonly Fix[]): number {
  if (fixes.length < 2) return 0;
  const typical = typicalGap(fixes);
  let cuts = 0;
  for (let i = 1; i < fixes.length; i++) {
    if (!reachable(fixes[i - 1], fixes[i], typical)) cuts++;
  }
  return cuts;
}
