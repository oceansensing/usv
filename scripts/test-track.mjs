#!/usr/bin/env node
/**
 * Where a track has to be cut.
 *
 *   npm run test:track
 *
 * The rule these check is the one that stops a map drawing a line the
 * vehicle did not sail. It exists because three 2024 Saildrones were
 * recovered in the Atlantic and their records continue with dock telemetry
 * from Alameda — so a polyline through every fix runs four thousand
 * kilometres across the United States, and looks exactly like a track.
 *
 * Half of these assert that an *ordinary* track is left alone. A rule that
 * cuts a real transit into pieces is worse than the line it was meant to
 * prevent: a broken track reads as missing data.
 */

import { check, done, near, ok, section } from './lib/check.mjs';
import {
  cutCount, GAP_FACTOR, MAX_SPEED, reachable, reachableRuns, typicalGap,
} from '../src/lib/reachable.ts';

/** A vehicle running due east at `mps`, reporting every `dt` seconds. */
function transit(n, { mps = 1.5, dt = 600, lat = 25, lon0 = -60, t0 = 1_780_000_000 } = {}) {
  const out = [];
  const degPerStep = (mps * dt) / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < n; i++) {
    out.push({ lat, lon: lon0 + i * degPerStep, t: t0 + i * dt });
  }
  return out;
}

/* ------------------------------------------------------------------------ */
section('an ordinary track is one run');

{
  const fixes = transit(200);
  check('a steady transit is not cut', cutCount(fixes), 0);
  const runs = reachableRuns(fixes);
  check('and comes back whole', runs.length, 1);
  check('with every fix in it', runs[0].length, 200);
  near('its typical gap is the reporting interval', typicalGap(fixes), 600, 1);
}

{
  /* A Saildrone Explorer makes about 3 m/s downwind in a good breeze. */
  check('3 m/s is a vehicle sailing, not a fault', cutCount(transit(100, { mps: 3 })), 0);
  check('and so is 5', cutCount(transit(100, { mps: 5 })), 0);
  /* An Oshen station-keeping barely moves. */
  check('and so is drifting', cutCount(transit(100, { mps: 0.05 })), 0);
}

{
  /* Consecutive fixes on the same second happen where a record carries two
     readings of one moment. Joining them is right; the distance is zero. */
  const fixes = [
    { lat: 25, lon: -60, t: 1000 },
    { lat: 25, lon: -60, t: 1000 },
    { lat: 25.001, lon: -60, t: 1600 },
  ];
  check('a repeated timestamp is not a cut', cutCount(fixes), 0);
}

/* ------------------------------------------------------------------------ */
section('a shipping leg is cut');

{
  /* sd1042_hurricane_2024: off Cape Hatteras, then San Francisco Bay, 4,055
     km and 20.2 days later. Reachable in *speed* — 2.3 m/s — which is the
     whole reason the speed test alone is not enough, and the silence is what
     gives it away. */
  const before = transit(50, { lat: 34.4, lon0: -76.9 });
  const last = before[before.length - 1];
  const after = [
    { lat: 37.8, lon: -122.3, t: last.t + 20.2 * 86400 },
    { lat: 37.8, lon: -122.31, t: last.t + 20.2 * 86400 + 600 },
    { lat: 37.8, lon: -122.32, t: last.t + 20.2 * 86400 + 1200 },
  ];
  const fixes = [...before, ...after];

  const speed = 4_055_000 / (20.2 * 86400);
  ok('the leap is slow enough to look sailable', speed < MAX_SPEED,
    `${speed.toFixed(2)} m/s, under the ${MAX_SPEED} m/s limit`);
  check('but it is still cut', cutCount(fixes), 1);

  const runs = reachableRuns(fixes);
  check('into two runs', runs.length, 2);
  check('the Atlantic one keeps its fixes', runs[0].length, 50);
  check('and the Alameda one keeps its own', runs[1].length, 3);
  ok('and no run spans the continent',
    runs.every((r) => Math.abs(r[0].lon - r[r.length - 1].lon) < 10),
    runs.map((r) => `${r[0].lon.toFixed(1)}→${r[r.length - 1].lon.toFixed(1)}`).join(' | '));
}

/* ------------------------------------------------------------------------ */
section('the three ways a step fails');

{
  const typical = 600;
  const a = { lat: 25, lon: -60, t: 1_780_000_000 };

  /* 1. Too fast: a bad fix, or a vehicle on a ship. */
  const fast = { lat: 25, lon: -50, t: a.t + 600 };
  ok('a 1,000 km leap in ten minutes is not reachable', !reachable(a, fast, typical));

  /* 2. Too long a silence: slow enough to sail, but nothing was observed
        between. sd1040_hurricane_2024 covers 947 km in 86 days. */
  const quiet = { lat: 25.1, lon: -59.9, t: a.t + 86 * 86400 };
  const mps = 947_000 / (86 * 86400);
  ok('  and 86 days of silence is not, however slow the implied speed',
    !reachable(a, quiet, typical), `${mps.toFixed(3)} m/s`);

  /* 3. Backwards: three Oshen records step back in time between rows. */
  const back = { lat: 25.001, lon: -60, t: a.t - 60 };
  ok('  nor is a step backwards in time', !reachable(a, back, typical));

  /* And the ordinary case, for contrast. */
  ok('while an ordinary step is', reachable(a, { lat: 25.005, lon: -60, t: a.t + 600 }, typical));
}

{
  /* The gap threshold is a multiple of the *drawn* spacing, not of the
     vehicle's raw cadence: a track is subsampled before it is drawn, so the
     honest comparison is with its neighbours. */
  const typical = 600;
  const a = { lat: 25, lon: -60, t: 0 };
  const justUnder = { lat: 25.001, lon: -60, t: GAP_FACTOR * typical - 1 };
  const justOver = { lat: 25.001, lon: -60, t: GAP_FACTOR * typical + 1 };
  ok(`a gap of just under ${GAP_FACTOR}× the spacing is joined`,
    reachable(a, justUnder, typical));
  ok('and just over is cut', !reachable(a, justOver, typical));
}

/* ------------------------------------------------------------------------ */
section('the awkward shapes');

check('nothing is no runs', reachableRuns([]).length, 0);
check('one fix is no run, because a line needs two', reachableRuns([{ lat: 1, lon: 2, t: 3 }]).length, 0);
ok('and no gap can be computed from one fix', Number.isNaN(typicalGap([{ lat: 1, lon: 2, t: 3 }])));

{
  /* A fix stranded between two cuts joins nothing and is not returned as a
     run of one — the caller still has it as a point. */
  const fixes = [
    { lat: 25, lon: -60, t: 0 },
    { lat: 25, lon: -60.01, t: 600 },
    { lat: 40, lon: -130, t: 1200 },     // leap in
    { lat: 10, lon: -20, t: 1800 },      // leap out
    { lat: 10, lon: -20.01, t: 2400 },
    { lat: 10, lon: -20.02, t: 3000 },
  ];
  const runs = reachableRuns(fixes);
  check('a stranded fix produces no run of its own', runs.length, 2);
  ok('and the runs either side are intact',
    runs[0].length === 2 && runs[1].length === 3,
    runs.map((r) => r.length).join(' + '));
}

{
  /* Every step impossible: no line at all, rather than a wrong one. */
  const fixes = [
    { lat: 0, lon: 0, t: 0 },
    { lat: 40, lon: -130, t: 60 },
    { lat: -40, lon: 130, t: 120 },
  ];
  check('a record of nothing but leaps draws no line', reachableRuns(fixes).length, 0);
}

/* ------------------------------------------------------------------------ */
section('the limit is the one the quality report uses');

/* A leap the quality report calls impossible and the map draws anyway would
   be the site contradicting itself on one screen. */
check('the map and the position check share a speed limit', MAX_SPEED, 8);

done();
