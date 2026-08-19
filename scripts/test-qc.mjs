#!/usr/bin/env node
/**
 * The quality checks, against records whose faults are known.
 *
 *   npm run test:qc
 *
 * Two kinds of fixture. **Synthetic** series carry one fault each, built so
 * the expected count is arithmetic rather than a judgement. And one **real**
 * record — `oshenPD22` on 2026-08-07 — whose fault was characterised
 * independently in the campaign analysis, so the detector can be checked
 * against a conclusion it did not produce.
 *
 * Half the checks here are that a check stays *quiet*. Every false positive
 * this package can produce pushes a real finding off the page, and a quality
 * report nobody trusts is worse than none.
 */

import fs from 'node:fs';
import { check, done, near, ok, section } from './lib/check.mjs';
import { parseJsonlCsv } from '../packages/erddap-pmel/index.ts';
import {
  cadence, dropout, gaps, haversine, MAX_MARKS, PLAUSIBLE, position, range,
  rank, reportingInterval, robustScale, sample, silent, spikes, stuck, tally,
  worst,
} from '../packages/usv-qc/index.ts';

/** A clean series: `n` samples every `dt` seconds from `t0`. */
const clock = (n, dt = 60, t0 = 1_786_665_600) =>
  Float64Array.from({ length: n }, (_, i) => t0 + i * dt);

/** Gentle noise that is deterministic, so a run is reproducible. */
const wobble = (i) => Math.sin(i * 0.7) * 0.05 + Math.sin(i * 0.13) * 0.03;

/* ------------------------------------------------------------------------ */
section('the robust scale a spike cannot inflate');

{
  /* The standard deviation is computed *from* the outliers this is looking
     for, so a record with a ±34 hPa artifact reports a σ large enough to
     hide it. The MAD does not move. */
  const clean = Array.from({ length: 400 }, (_, i) => wobble(i));
  const spiked = [...clean];
  for (let i = 20; i < 400; i += 40) spiked[i] += 34;

  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  ok('the standard deviation is wrecked by the spikes',
    sd(spiked) / sd(clean) > 20, `${(sd(spiked) / sd(clean)).toFixed(1)}×`);
  ok('the robust scale barely moves',
    Math.abs(robustScale(spiked) / robustScale(clean) - 1) < 0.15,
    `${(robustScale(spiked) / robustScale(clean)).toFixed(3)}×`);
}

ok('too few values gives NaN rather than a number', Number.isNaN(robustScale([1, 2])));

/* ------------------------------------------------------------------------ */
section('gaps are measured against the vehicle\'s own cadence');

{
  /* Ten minutes of silence: a fault on a 1-minute Saildrone, normal on a
     5-minute Oshen where it is two missed reports. */
  const t = Float64Array.from([...clock(100), ...clock(100, 60, 1_786_665_600 + 100 * 60 + 600)]);
  check('a 1-minute vehicle reports it', gaps(t, 60).length, 1);
  check('and a 5-minute vehicle does not', gaps(t, 300).length, 0);
}

{
  const t = clock(2000, 60);
  check('a clean record has no gaps', gaps(t, 60).length, 0);
}

{
  /* Two long gaps in a short record: a fifth of the span lost. */
  const t = Float64Array.from([
    ...clock(100, 60),
    ...clock(100, 60, 1_786_665_600 + 100 * 60 + 7200),
    ...clock(100, 60, 1_786_665_600 + 200 * 60 + 14400),
  ]);
  const f = gaps(t, 60);
  check('both are found', f[0].count, 2);
  check('and a fifth of the record lost is worth more than a note',
    f[0].severity, 'medium');
  ok('the summary says how much was lost', /lost in total/.test(f[0].summary), f[0].summary);
}

check('a cadence of zero cannot be divided by', gaps(clock(100), 0).length, 0);

/* ------------------------------------------------------------------------ */
section('spikes: a step out and an immediate step back');

{
  const t = clock(600, 300);
  const p = Float64Array.from({ length: 600 }, (_, i) => 1013 + wobble(i));
  check('a clean pressure record has no spikes',
    spikes(t, p, 'air_pressure', 'hPa').length, 0);

  /* The Oshen artifact's own magnitudes. */
  const spiked = Float64Array.from(p);
  for (const [i, m] of [[100, 8.5], [200, -17], [300, 34], [400, -8.5]]) spiked[i] += m;
  const f = spikes(t, spiked, 'air_pressure', 'hPa');
  check('four planted spikes are found', f[0].count, 4);
  ok('and the largest is reported', /34/.test(f[0].summary), f[0].summary);
}

{
  /* **A step that is not reversed is weather.** A front, a squall, a vehicle
     entering an eddy — all real, all unmarked. This is the whole reason the
     test is a shape rather than a magnitude. */
  const t = clock(600, 300);
  const p = Float64Array.from({ length: 600 }, (_, i) => (i < 300 ? 1013 : 1030) + wobble(i));
  check('a 17 hPa step that stays is not a spike',
    spikes(t, p, 'air_pressure', 'hPa').length, 0);

  const ramp = Float64Array.from({ length: 600 }, (_, i) => 1013 - i * 0.05 + wobble(i));
  check('nor is a 30 hPa fall over a day', spikes(t, ramp, 'air_pressure', 'hPa').length, 0);
}

{
  /* The absolute floor is what stops a quiet record being reported. Six
     robust sigmas of a 0.045 hPa step distribution is 0.27 hPa, which is
     weather; the floor of 3 hPa is what actually decides. */
  const t = clock(400, 300);
  const p = Float64Array.from({ length: 400 }, (_, i) => 1013 + wobble(i));
  const nudged = Float64Array.from(p);
  nudged[200] += 1.0;
  check('a 1 hPa blip is below the floor and is not reported',
    spikes(t, nudged, 'air_pressure', 'hPa').length, 0);
}

check('a quantity with no floor is not spike-tested',
  spikes(clock(100), new Float64Array(100), 'magnetic_x', 'µT').length, 0);

/* ------------------------------------------------------------------------ */
section('spikes, against a real record characterised independently');

{
  /* oshenPD22, 2026-08-07. The campaign analysis
     (truedichotomy/NOAA-USV-analysis, src/oshen_qc.jl) found the Aug-4
     cohort emitting single-sample pressure spikes quantized at ±8.5/±17/±34
     hPa. This detector was written from that description but not from its
     numbers, so agreeing is a real check. */
  const names = ['time', 'latitude', 'longitude', 'air_pressure_mean', 'sst_mean',
    'wind_speed_mean_motion_corrected', 'relative_humidity_mean'];
  const p = parseJsonlCsv(
    fs.readFileSync(new URL('./fixtures/erddap/rows-oshenPD22.jsonl', import.meta.url), 'utf8'),
    { names, timeColumns: new Set(['time']) });
  const t = p.columns.get('time');
  const pres = p.columns.get('air_pressure_mean');

  ok('the fixture is one day of PD22', p.rows > 600 && p.rows < 800, `${p.rows} rows`);

  const f = spikes(t, pres, 'air_pressure', 'hPa');
  check('the artifact is found', f.length, 1);
  check('21 events in the day', f[0].count, 21);
  ok('at the ±17 hPa quantization the campaign analysis reported',
    /17/.test(f[0].summary), f[0].summary);
  check('and it is not dismissed as a note', f[0].severity, 'medium');

  /* The values are left exactly as published. */
  ok('nothing was altered', pres.some((v) => Number.isFinite(v)));

  /* The same day's other channels are clean, which is the point: this is a
     pressure telemetry fault, not a vehicle in trouble. */
  check('sea temperature the same day is clean',
    spikes(t, p.columns.get('sst_mean'), 'sea_temperature', '°C').length, 0);
  check('and the wind', spikes(t, p.columns.get('wind_speed_mean_motion_corrected'),
    'wind_speed', 'm/s').length, 0);
  check('and there are no gaps in it', gaps(t, 300).length, 0);
}

/* ------------------------------------------------------------------------ */
section('stuck: measured in time, because these instruments quantize');

{
  /* **An Oshen publishes sea temperature to 0.05 °C.** A calm night
     legitimately repeats a value for many consecutive samples, and a test
     written as "identical consecutive values" reports every Oshen in the
     fleet as broken. */
  const t = clock(300, 300);   // 25 hours at 5 minutes
  const quantized = Float64Array.from({ length: 300 },
    (_, i) => Math.round((29 + Math.sin(i / 40)) / 0.05) * 0.05);
  check('a quantized but changing record is not stuck',
    stuck(t, quantized, 'sea_temperature', '°C').length, 0);

  const dead = Float64Array.from(quantized);
  for (let i = 100; i < 300; i++) dead[i] = 29.25;   // ~16.6 hours frozen
  const f = stuck(t, dead, 'sea_temperature', '°C');
  check('a sensor frozen for 16 hours is', f.length, 1);
  ok('and the run length is reported', /h|days/.test(f[0].summary), f[0].summary);
}

{
  /* A run of three identical values at a 5-minute cadence is ten minutes,
     which is nothing. */
  const t = clock(300, 300);
  const v = Float64Array.from({ length: 300 }, (_, i) => 29 + wobble(i));
  for (let i = 50; i < 54; i++) v[i] = 29;
  check('a four-sample run is far too short to mean anything',
    stuck(t, v, 'sea_temperature', '°C').length, 0);
}

/* ------------------------------------------------------------------------ */
section('range: what a quantity cannot physically be');

{
  const t = clock(200, 60);
  const v = Float64Array.from({ length: 200 }, (_, i) => 25 + wobble(i));
  check('ordinary tropical air is in range', range(t, v, 'air_temperature', '°C').length, 0);

  /* An undecoded sentinel is the case this exists for. */
  const sentinel = Float64Array.from(v);
  sentinel[100] = -999;
  const f = range(t, sentinel, 'air_temperature', '°C');
  check('a -999 sentinel is caught', f[0].count, 1);
  check('one excursion is a sensor glitch, not a broken record', f[0].severity, 'medium');
}

{
  /* A unit that was never converted puts the whole record outside. A
     barometer published in kPa and read as hPa is 101.3 against a range
     starting at 850. (900 hPa would *not* fire, and should not: that is a
     deep hurricane core, which is exactly the thing this archive exists to
     measure.) */
  const t = clock(200, 60);
  const kPa = Float64Array.from({ length: 200 }, (_, i) => 101.3 + wobble(i));
  const f = range(t, kPa, 'air_pressure', 'hPa');
  check('a whole record outside the range is a different fault', f[0].severity, 'high');
  ok('and the detail says why', /never converted/.test(f[0].detail), f[0].detail);
}

{
  /* The ranges hold from an Arctic October to a Caribbean August, because
     one table serves the whole archive. */
  const t = clock(50, 60);
  for (const [q, v] of [['sea_temperature', -1.8], ['sea_temperature', 32.5],
    ['air_temperature', -45], ['air_temperature', 42], ['air_pressure', 880],
    ['air_pressure', 1050], ['salinity', 32], ['wind_speed', 65]]) {
    check(`${q} = ${v} is plausible somewhere in this archive`,
      range(t, new Float64Array(50).fill(v), q, '').length, 0);
  }
}

ok('a quantity with no range is not tested',
  range(clock(50), new Float64Array(50).fill(1e9), 'magnetic_x', 'µT').length === 0);

for (const [key, [lo, hi]] of Object.entries(PLAUSIBLE)) {
  ok(`${key}'s range is ordered`, lo < hi, `${lo} … ${hi}`);
}

/* ------------------------------------------------------------------------ */
section('dropout: dead is not the same as intermittent');

{
  const t = clock(1440, 60);   // 24 hours at 1 minute
  const v = Float64Array.from({ length: 1440 }, (_, i) => 29 + wobble(i));
  check('a complete column has nothing to report',
    dropout(t, v, 'sea_temperature').length, 0);

  /* PD13: sea temperature stopped and never came back, while the vehicle
     kept reporting. The whole 12-hour trailing window has to be empty for
     this to be "dead" rather than "intermittent" — a window a third full is
     ambiguous, and the honest answer there is the intermittent branch. */
  const dead = Float64Array.from(v);
  for (let i = 700; i < 1440; i++) dead[i] = NaN;
  const f = dropout(t, dead, 'sea_temperature');
  check('a sensor dead at the end of the record is high severity', f[0].severity, 'high');
  ok('and the summary says the vehicle kept reporting',
    /while the vehicle kept reporting/.test(f[0].summary), f[0].summary);

  /* A sensor that stops for seven hours and is still stopped at the end of
     a 24-hour record leaves the trailing window a third full — not enough to
     call dead. It reports as intermittent, which is what is actually known. */
  const ambiguous = Float64Array.from(v);
  for (let i = 1000; i < 1440; i++) ambiguous[i] = NaN;
  check('a partly-empty trailing window is not called dead',
    dropout(t, ambiguous, 'sea_temperature')[0].severity, 'medium');

  /* PD19: 19% missing over the record, clean for the last two days. */
  const patchy = Float64Array.from(v);
  for (let i = 0; i < 1000; i += 4) patchy[i] = NaN;
  const g = dropout(t, patchy, 'sea_temperature');
  check('scattered gaps with a live tail are medium', g[0].severity, 'medium');
  ok('and it says the sensor is still alive', /still alive/.test(g[0].detail), g[0].detail);
}

{
  const t = clock(1440, 60);
  const f = dropout(t, new Float64Array(1440).fill(NaN), 'chlorophyll');
  check('a column that is declared and never filled', f[0].severity, 'high');
  ok('is distinguished from one that is absent',
    /present but empty/.test(f[0].summary), f[0].summary);
}

{
  /* **Sparse is not missing.** A Saildrone's SBE37 reports every 5 minutes
     into a 1-minute record: 80% of rows empty and a perfectly healthy
     instrument. `reportingInterval` is what the caller uses to tell them
     apart. */
  const t = clock(1440, 60);
  const sbe = Float64Array.from({ length: 1440 }, (_, i) => (i % 5 === 0 ? 29 + wobble(i) : NaN));
  near('the column reports every 5 minutes', reportingInterval(t, sbe), 300, 1);
  ok('which is well above the 60-second row cadence', reportingInterval(t, sbe) > 60 * 1.5);
  /* The trailing-window test still fires for a real death, whatever the
     column's own rate. */
  const sparseThenDead = Float64Array.from(sbe);
  for (let i = 700; i < 1440; i++) sparseThenDead[i] = NaN;
  check('and a sparse column that dies is still caught',
    dropout(t, sparseThenDead, 'sea_temperature')[0].severity, 'high');
}

/* ------------------------------------------------------------------------ */
section('cadence changes');

{
  const t = clock(4000, 60);
  check('a steady record has none', cadence(t).length, 0);

  const first = clock(2000, 60);
  const switched = Float64Array.from([
    ...first,
    ...clock(2000, 300, first[first.length - 1] + 300),
  ]);
  const f = cadence(switched);
  ok('a switch from 1 to 5 minutes is found', f.length === 1, JSON.stringify(f.map(x => x.summary)));
  ok('and both rates are named', /1 min|60 s/.test(f[0].summary) && /5 min/.test(f[0].summary),
    f[0].summary);
}

/* ------------------------------------------------------------------------ */
section('position');

near('a degree of latitude is 111 km', haversine(0, 0, 1, 0) / 1000, 111.2, 0.5);
near('and a degree of longitude shrinks with the cosine',
  haversine(60, 0, 60, 1) / 1000, 55.6, 0.5);

{
  const t = clock(500, 60);
  const lat = Float64Array.from({ length: 500 }, (_, i) => 24 + i * 0.0005);
  const lon = Float64Array.from({ length: 500 }, () => -65);
  check('a steady track is clean', position(t, lat, lon).length, 0);

  /* The null island is in the Gulf of Guinea, thousands of kilometres from
     anything in this archive, and it drags a track across an ocean the
     vehicle never entered. */
  const zeroed = Float64Array.from(lat);
  const zeroedLon = Float64Array.from(lon);
  zeroed[200] = 0; zeroedLon[200] = 0;
  const f = position(t, zeroed, zeroedLon);
  ok('an uninitialised fix at 0,0 is found',
    f.some((x) => /0°N 0°E/.test(x.summary)), f.map((x) => x.summary).join(' | '));
  check('and it is high severity',
    f.find((x) => /0°N 0°E/.test(x.summary)).severity, 'high');
  ok('and it is not also counted as a jump, because it is excluded first',
    !f.some((x) => /jump/.test(x.summary)), f.map((x) => x.summary).join(' | '));

  const missing = Float64Array.from(lat);
  missing[100] = NaN;
  const g = position(t, missing, lon);
  ok('a missing fix is reported', g.some((x) => /no position/.test(x.summary)));
  ok('and only as low severity, since a track simply skips it',
    g.find((x) => /no position/.test(x.summary)).severity === 'low');

  /* A Saildrone makes about 3 m/s. */
  const jumped = Float64Array.from(lat);
  jumped[300] = 30;
  const h = position(t, jumped, lon);
  ok('an unreachable jump is found', h.some((x) => /jump/.test(x.summary)),
    h.map((x) => x.summary).join(' | '));
}

/* ------------------------------------------------------------------------ */
section('silent');

{
  const now = 1_787_000_000;
  check('a vehicle reporting two hours ago is not silent',
    silent(now - 7200, now).length, 0);
  check('nor one at eighteen hours', silent(now - 18 * 3600, now).length, 0);
  ok('two days is', silent(now - 2 * 86400, now).length === 1);
  check('and ten days is worth more than a note',
    silent(now - 10 * 86400, now)[0].severity, 'medium');
  ok('what it cannot tell apart is said out loud',
    /cannot tell those apart/.test(silent(now - 10 * 86400, now)[0].detail));
}

/* ------------------------------------------------------------------------ */
section('the report itself');

{
  const f = [
    { check: 'gap', severity: 'low', summary: 'a', start: 5 },
    { check: 'range', severity: 'high', summary: 'b', start: 3 },
    { check: 'spike', severity: 'medium', summary: 'c', start: 1 },
    { check: 'metadata', severity: 'note', summary: 'd', start: 0 },
  ];
  check('the worst severity is found', worst(f), 'high');
  check('and nothing found is undefined rather than "fine"', worst([]), undefined);
  check('the order is most severe first', rank(f).map((x) => x.severity).join(','),
    'high,medium,low,note');

  /* The report is written to a file that is diffed between builds, so an
     unstable sort would show every dataset as changed every night. */
  const shuffled = [f[2], f[0], f[3], f[1]];
  check('and it is stable against input order',
    JSON.stringify(rank(f)), JSON.stringify(rank(shuffled)));

  const t = tally(f);
  check('the tally counts each check', `${t.gap}${t.range}${t.spike}${t.metadata}`, '1111');
  check('and zero for the rest', t.stuck, 0);
}

/* ------------------------------------------------------------------------ */
section('marks are capped, and the count is not');

{
  const many = Array.from({ length: 5000 }, (_, i) => i);
  const s = sample(many, MAX_MARKS);
  check('the sample is capped', s.length, MAX_MARKS);
  check('it starts at the beginning', s[0], 0);
  check('and ends at the end', s[s.length - 1], 4999);
  ok('and is ascending', s.every((v, i) => i === 0 || v > s[i - 1]));
  check('a short list is returned whole', sample([1, 2, 3], MAX_MARKS).length, 3);
}

{
  /* A record with thousands of spikes needs a count and a mark every so
     often, not thousands of marks and a JSON file larger than the data. */
  const t = clock(6000, 60);
  const p = Float64Array.from({ length: 6000 }, (_, i) => 1013 + wobble(i));
  for (let i = 5; i < 6000; i += 10) p[i] += 20;
  const f = spikes(t, p, 'air_pressure', 'hPa');
  ok('the count is the true total', f[0].count > MAX_MARKS, `${f[0].count}`);
  check('and the marks are capped', f[0].marks.length, MAX_MARKS);
}

{
  /* **When a third of the samples are excursions they are not excursions.**
     The relative half of the threshold does this on its own: with a spike
     every third sample the step distribution *is* ±20 hPa, six robust sigmas
     of it is 120, and nothing is reported. That is the right answer — a
     signal that behaves this way is the instrument's normal output, or the
     record is so corrupt that marking individual samples is beside the
     point. Asserted because it looks like a miss and is not. */
  const t = clock(4000, 60);
  const p = Float64Array.from({ length: 4000 }, (_, i) => 1013 + wobble(i));
  for (let i = 2; i < 4000; i += 3) p[i] += 20;
  check('a record that is a third excursions reports none',
    spikes(t, p, 'air_pressure', 'hPa').length, 0);
}

done();
