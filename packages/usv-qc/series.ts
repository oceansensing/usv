/**
 * The checks that read a series of numbers.
 *
 * Six of the nine. Each takes a column and returns findings; none of them
 * writes anything back. See `types.ts` for why that rule is absolute here.
 *
 * ## Thresholds are two-part, and both parts are needed
 *
 * A purely **relative** threshold — some multiple of the record's own scatter
 * — fires constantly on a quiet record. A one-minute barometric record has a
 * robust σ of about 0.02 hPa between samples, so six of those is 0.12 hPa,
 * which is weather.
 *
 * A purely **absolute** threshold cannot serve both a Caribbean August and an
 * Arctic October in the same table.
 *
 * So every threshold here is `max(k × robustScale, floorForTheQuantity)`.
 * The relative part adapts; the absolute part is what stops a still day
 * being reported as a fault. Both are in `MIN_SPIKE` and they were chosen
 * against real records, not derived.
 */

import type { Check, Finding, Severity } from './types.ts';
import { MAX_MARKS } from './types.ts';

/* --------------------------------------------------------------- scale -- */

/**
 * A scatter estimate a spike cannot inflate.
 *
 * The median absolute deviation, scaled by 1.4826 so it equals σ for
 * Gaussian data. The standard deviation is the wrong tool here by
 * construction: it is computed *from* the outliers this is looking for, so a
 * record with a ±34 hPa artifact reports a σ large enough to hide it.
 *
 * Sampled rather than fully sorted — this runs over 150,000-row columns and
 * a median is settled long before the last sample. The stride is
 * deterministic, so the same data gives the same answer every build.
 */
export function robustScale(values: readonly number[] | Float64Array): number {
  const finite: number[] = [];
  const stride = Math.max(1, Math.floor(values.length / 20_000));
  for (let i = 0; i < values.length; i += stride) {
    const v = values[i];
    if (Number.isFinite(v)) finite.push(v);
  }
  if (finite.length < 8) return NaN;
  const med = median(finite);
  const dev = finite.map((v) => Math.abs(v - med));
  return 1.4826 * median(dev);
}

function median(xs: number[]): number {
  const a = [...xs].sort((p, q) => p - q);
  const n = a.length;
  if (!n) return NaN;
  return n % 2 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

/** First differences, missing where either end is. */
function differences(values: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (Number.isFinite(d)) out.push(d);
  }
  return out;
}

/* ------------------------------------------------------------ the gaps -- */

/**
 * Stretches where the vehicle stopped reporting.
 *
 * Measured against the record's **own** cadence rather than a constant: an
 * Oshen reports every two to five minutes and a Saildrone every minute, so a
 * ten-minute silence means different things on each.
 *
 * Only the *time* column is read. A gap is the vehicle or its link, not a
 * sensor — a sensor that stops while the vehicle keeps reporting is a
 * `dropout`, and telling those two apart is most of what makes a quality
 * report worth reading. PD23 in August 2026 is the case that made this
 * distinction concrete: 24 interruptions of 35–79 minutes, normal values
 * whenever it did report, and a continuous track. A link problem, not a
 * sensor one.
 */
export function gaps(
  time: Float64Array, cadenceSeconds: number, options: { minFactor?: number } = {},
): Finding[] {
  const factor = options.minFactor ?? 6;
  if (!(cadenceSeconds > 0) || time.length < 3) return [];
  const threshold = cadenceSeconds * factor;

  const spans: Array<[number, number]> = [];
  for (let i = 1; i < time.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt > threshold) spans.push([time[i - 1], time[i]]);
  }
  if (!spans.length) return [];

  const lost = spans.reduce((sum, [a, b]) => sum + (b - a), 0);
  const longest = spans.reduce((m, [a, b]) => Math.max(m, b - a), 0);
  const total = time[time.length - 1] - time[0];

  /* A day of silence in a week is a different fact from a day of silence in
     a year, so the severity is the fraction lost rather than the hours. */
  const fraction = total > 0 ? lost / total : 0;
  const severity: Severity = fraction > 0.2 || longest > 86400 ? 'medium' : 'low';

  return [{
    check: 'gap',
    severity,
    summary: `${spans.length} reporting gap${spans.length === 1 ? '' : 's'} longer than `
      + `${humanDuration(threshold)}, ${humanDuration(lost)} lost in total`,
    detail: `The longest is ${humanDuration(longest)}. That is `
      + `${(100 * fraction).toFixed(1)} % of the record's span. Measured against this `
      + `vehicle's own median cadence of ${humanDuration(cadenceSeconds)}, so it means `
      + 'the same thing on a 1-minute Saildrone and a 5-minute Oshen. A gap is the '
      + 'vehicle or its link; a sensor that stops while the vehicle keeps reporting is '
      + 'a dropout and is listed separately.',
    start: spans[0][0],
    end: spans[spans.length - 1][1],
    count: spans.length,
    marks: spans.slice(0, MAX_MARKS).map(([a]) => a),
  }];
}

/* ---------------------------------------------------------- the spikes -- */

/**
 * The minimum step that counts as a spike, per quantity, in the quantity's
 * canonical units.
 *
 * These are the absolute half of the threshold — below them, nothing is
 * reported however unusual it is relative to a quiet record. Chosen against
 * real data:
 *
 * - **3 hPa** for pressure is the figure the 2026 campaign analysis used to
 *   isolate the Oshen telemetry artifact, whose steps are quantized at
 *   ±8.5, ±17 and ±34 hPa. Real barometric change over one to five minutes
 *   does not approach it, even in a hurricane.
 * - **1 °C** for a sea temperature between consecutive samples minutes
 *   apart: a vehicle crossing a front does not do that, and a sensor
 *   dropping a bit does.
 * - Air temperature is looser at 3 °C, because a rain squall genuinely does
 *   that in a minute.
 */
export const MIN_SPIKE: Record<string, number> = {
  air_pressure: 3,
  sea_temperature: 1,
  skin_temperature: 2,
  air_temperature: 3,
  salinity: 0.5,
  conductivity: 1,
  relative_humidity: 20,
  wind_speed: 15,
  wind_gust: 20,
  oxygen_concentration: 30,
  chlorophyll: 5,
  wave_height: 2,
};

/**
 * Single-sample excursions: a step out and an immediate step back.
 *
 * The shape is the whole test. A step that is not reversed is the ocean or
 * the weather — a front, a squall, a vehicle entering an eddy — and it stays
 * unmarked. A step reversed by the very next sample is an instrument or a
 * telemetry frame, because nothing physical at these scales moves and
 * returns within one sampling interval.
 *
 * Adapted from `vspikes` in the campaign analysis
 * (truedichotomy/NOAA-USV-analysis, `src/oshen_qc.jl`), which is where the
 * Oshen pressure artifact was characterised.
 *
 * **A direction is not run through this.** A bearing crossing north steps by
 * 359° and back, which is the exact signature this looks for and is not a
 * fault. `report.ts` skips circular quantities.
 */
export function spikes(
  time: Float64Array, values: Float64Array, quantity: string, units: string,
): Finding[] {
  const floor = MIN_SPIKE[quantity];
  if (floor === undefined) return [];

  const scale = robustScale(differences(values));
  /* Six robust sigmas of the *step* distribution, or the quantity's floor,
     whichever is larger. On a quiet record the floor wins; on a rough one
     the relative part keeps this from reporting real weather. */
  const threshold = Math.max(floor, Number.isFinite(scale) ? 6 * scale : 0);

  const at: number[] = [];
  const magnitudes: number[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const a = values[i - 1];
    const b = values[i];
    const c = values[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
    const d1 = b - a;
    const d2 = c - b;
    if (Math.abs(d1) > threshold && Math.abs(d2) > threshold && Math.sign(d1) !== Math.sign(d2)) {
      at.push(time[i]);
      magnitudes.push(d1);
    }
  }
  if (!at.length) return [];

  const biggest = magnitudes.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
  return [{
    check: 'spike',
    severity: at.length > 20 ? 'medium' : 'low',
    quantity,
    summary: `${at.length} single-sample spike${at.length === 1 ? '' : 's'}, `
      + `up to ${Math.abs(biggest).toFixed(1)} ${units}`.trimEnd(),
    detail: `A step of more than ${threshold.toFixed(2)} ${units} reversed by the very `
      + 'next sample. A step that is not reversed is weather or a front and is not '
      + 'marked; nothing physical moves and returns within one sampling interval at '
      + 'this scale. The values are left exactly as published — despike before using '
      + 'this record quantitatively.',
    start: at[0],
    end: at[at.length - 1],
    count: at.length,
    marks: sample(at, MAX_MARKS),
  }];
}

/* ----------------------------------------------------------- the stuck -- */

/**
 * A sensor reporting the same number over and over.
 *
 * The trap is quantization: an Oshen's SST is published to 0.05 °C and its
 * humidity to 1 %, so a calm night legitimately produces long runs of one
 * value. A test written as "identical consecutive values" reports every
 * Oshen in the fleet as broken.
 *
 * So the run has to be long **in time** rather than in samples, and the
 * quantity has to be one that does not sit still: a bearing at anchor and a
 * wind sensor in a calm both repeat honestly.
 */
export function stuck(
  time: Float64Array, values: Float64Array, quantity: string, units: string,
  options: { minHours?: number } = {},
): Finding[] {
  const minSeconds = (options.minHours ?? 6) * 3600;
  const runs: Array<{ start: number; end: number; value: number }> = [];

  let i = 0;
  while (i < values.length) {
    const v = values[i];
    if (!Number.isFinite(v)) { i++; continue; }
    let j = i + 1;
    while (j < values.length && values[j] === v) j++;
    if (j - i >= 3 && time[j - 1] - time[i] >= minSeconds) {
      runs.push({ start: time[i], end: time[j - 1], value: v });
    }
    i = j;
  }
  if (!runs.length) return [];

  const longest = runs.reduce((m, r) => Math.max(m, r.end - r.start), 0);
  return [{
    check: 'stuck',
    severity: longest > 24 * 3600 ? 'medium' : 'low',
    quantity,
    summary: `${runs.length} run${runs.length === 1 ? '' : 's'} of an unchanging value, `
      + `the longest ${humanDuration(longest)}`,
    detail: `Measured in elapsed time rather than in samples, because these instruments `
      + `quantize — an Oshen publishes sea temperature to 0.05 ${units || '°C'} and `
      + 'humidity to 1 %, so a calm night legitimately repeats a value for many '
      + 'consecutive samples. A run this long is more likely a sensor that has stopped '
      + 'responding than water that has stopped changing, but it is not proof of one.',
    start: runs[0].start,
    end: runs[runs.length - 1].end,
    count: runs.length,
    marks: sample(runs.map((r) => r.start), MAX_MARKS),
  }];
}

/* ----------------------------------------------------------- the range -- */

/**
 * Values outside what the quantity can physically be.
 *
 * **Wide on purpose.** These are not "unusual", they are "not a measurement
 * of this" — the ranges hold from an Arctic October to a Caribbean August,
 * because one table serves the whole archive. Anything narrower would report
 * the Bering Sea as faulty every autumn.
 *
 * A value at the very edge is not flagged. The point is to catch a sentinel
 * that was not decoded, a unit that was not converted, and a sensor
 * returning its rail — not to referee the weather.
 */
export const PLAUSIBLE: Record<string, [number, number]> = {
  air_temperature: [-60, 60],
  sea_temperature: [-2.5, 40],
  skin_temperature: [-2.5, 45],
  air_pressure: [850, 1090],
  relative_humidity: [0, 105],
  wind_speed: [0, 120],
  wind_gust: [0, 150],
  wind_direction: [0, 360],
  salinity: [0, 45],
  conductivity: [0, 70],
  oxygen_concentration: [0, 600],
  oxygen_saturation: [0, 200],
  chlorophyll: [-1, 100],
  cdom: [-5, 500],
  wave_height: [0, 30],
  wave_period_dominant: [0, 30],
  wave_period_mean: [0, 30],
  par: [-10, 3000],
  shortwave_down: [-20, 1500],
  longwave_down: [0, 700],
  speed_over_ground: [0, 15],
  course_over_ground: [0, 360],
  heading: [0, 360],
  pitch: [-90, 90],
  roll: [-180, 180],
  u10: [0, 150],
};

export function range(
  time: Float64Array, values: Float64Array, quantity: string, units: string,
): Finding[] {
  const limits = PLAUSIBLE[quantity];
  if (!limits) return [];
  const [lo, hi] = limits;

  const at: number[] = [];
  let worstValue = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo || v > hi) {
      at.push(time[i]);
      if (!Number.isFinite(worstValue)
        || Math.abs(v - clamp(v, lo, hi)) > Math.abs(worstValue - clamp(worstValue, lo, hi))) {
        worstValue = v;
      }
    }
  }
  if (!at.length) return [];

  const fraction = at.length / values.length;
  return [{
    check: 'range',
    /* A handful is a sensor glitch; a fifth of the record is a unit that was
       never converted, and every number in it is wrong. */
    severity: fraction > 0.2 ? 'high' : 'medium',
    quantity,
    summary: `${at.length} value${at.length === 1 ? '' : 's'} outside `
      + `${lo} to ${hi} ${units}`.trimEnd() + `, worst ${worstValue}`,
    detail: `The range is what this quantity can physically be, not what is usual — `
      + 'it holds from an Arctic October to a Caribbean August, because one table '
      + `serves the whole archive. ${fraction > 0.2
        ? 'A fifth of the record being outside it usually means a unit that was never '
          + 'converted or a sentinel that was never decoded, rather than a sensor fault.'
        : 'A handful of excursions is usually a sensor returning its rail or an '
          + 'undecoded sentinel value.'} Nothing was removed.`,
    start: at[0],
    end: at[at.length - 1],
    count: at.length,
    marks: sample(at, MAX_MARKS),
  }];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/* --------------------------------------------------------- the dropout -- */

/**
 * A sensor that is missing where the vehicle is not.
 *
 * Two distinct things, and the difference matters:
 *
 * - **Dead**: nothing for the last stretch of the record while the vehicle
 *   kept reporting. PD13's sea temperature stopped on 2026-08-14 and never
 *   came back.
 * - **Intermittent**: a high missing fraction spread through. PD19's was 19 %
 *   over its record and clean for the last two days.
 *
 * A page that says only "19 % missing" for both cannot be acted on. The
 * trailing window is what separates them.
 *
 * **Sparse is not missing.** A Saildrone's SBE37 reports every five minutes
 * into a one-minute record, which is 80 % of rows empty and a perfectly
 * healthy instrument. The comparison is against the column's *own* usual
 * reporting interval, established over the first part of the record, not
 * against the row count.
 */
export function dropout(
  time: Float64Array, values: Float64Array, quantity: string,
  options: { tailHours?: number } = {},
): Finding[] {
  const n = values.length;
  if (n < 20) return [];
  const tail = (options.tailHours ?? 12) * 3600;
  const end = time[n - 1];

  let present = 0;
  let tailPresent = 0;
  let tailRows = 0;
  let lastPresent = NaN;
  for (let i = 0; i < n; i++) {
    const ok = Number.isFinite(values[i]);
    if (ok) { present++; lastPresent = time[i]; }
    if (time[i] >= end - tail) {
      tailRows++;
      if (ok) tailPresent++;
    }
  }
  if (present === 0) {
    return [{
      check: 'dropout',
      severity: 'high',
      quantity,
      summary: 'the column is present but empty for the whole record',
      detail: 'Every value is missing. The dataset declares this variable and never '
        + 'published a number in it, which is a different thing from the variable '
        + 'being absent — and worth knowing, because a plot of it is blank rather '
        + 'than missing.',
      start: time[0],
      end,
      count: n,
    }];
  }

  const missingFraction = 1 - present / n;
  const findings: Finding[] = [];

  /* Dead: effectively nothing in the trailing window while the vehicle was
     still reporting rows in it.
   *
     The threshold is 90 % of the window missing rather than 100 %, which is
     the same rule `oshen_qc.jl` uses in the campaign analysis and is there
     because a dying sensor stutters before it stops. A window with a third
     of its values present is genuinely ambiguous — that record falls through
     to the intermittent branch below, which is the honest answer. */
  if (tailRows >= 10 && tailPresent / tailRows < 0.1) {
    findings.push({
      check: 'dropout',
      severity: 'high',
      quantity,
      summary: `no data since ${isoDay(lastPresent)}, while the vehicle kept reporting`,
      detail: `The last value was at ${isoTime(lastPresent)}, and the record continues `
        + `to ${isoTime(end)} with ${tailRows} rows in the final `
        + `${humanDuration(tail)} and ${tailPresent} of them carrying this variable. `
        + 'The vehicle is reporting and this sensor is not, which is a sensor failure '
        + 'rather than a telemetry gap.',
      start: lastPresent,
      end,
      count: tailRows - tailPresent,
    });
  } else if (missingFraction > 0.15) {
    /* Intermittent. Only reported when the column is not simply sparser than
       the record — that comparison is made by the caller, which knows the
       column's own reporting interval. */
    findings.push({
      check: 'dropout',
      severity: 'medium',
      quantity,
      summary: `${(100 * missingFraction).toFixed(0)} % of values missing, spread through `
        + 'the record',
      detail: `${present} of ${n} rows carry a value. The final `
        + `${humanDuration(tail)} is ${(100 * tailPresent / Math.max(tailRows, 1)).toFixed(0)} % `
        + 'complete, so the sensor is still alive — this is an intermittent fault or a '
        + 'partial telemetry loss rather than a failure.',
      start: time[0],
      end,
      count: n - present,
    });
  }
  return findings;
}

/**
 * The interval at which a column actually carries values, as opposed to the
 * interval at which the vehicle reports rows.
 *
 * This is what stops a healthy five-minute CTD in a one-minute record being
 * called 80 % missing. Established over the record so that a sensor which
 * *changes* rate is still caught by `cadence`.
 */
export function reportingInterval(time: Float64Array, values: Float64Array): number {
  const at: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) at.push(time[i]);
  }
  if (at.length < 3) return NaN;
  const deltas: number[] = [];
  for (let i = 1; i < at.length; i++) {
    const d = at[i] - at[i - 1];
    if (d > 0) deltas.push(d);
  }
  return deltas.length ? median(deltas) : NaN;
}

/* --------------------------------------------------------- the cadence -- */

/**
 * The vehicle's reporting interval changing part-way through.
 *
 * Worth reporting because it silently changes what every other statistic in
 * the record means: a mean over a record that was one-minute for a month and
 * five-minute for two is not an average of anything in particular, and a
 * spectrum computed across the change is nonsense.
 *
 * Compared as a ratio rather than a difference — the step from 1 to 2 minutes
 * matters as much as the one from 30 to 60.
 */
export function cadence(
  time: Float64Array, options: { windowRows?: number; ratio?: number } = {},
): Finding[] {
  const w = options.windowRows ?? 500;
  const ratio = options.ratio ?? 2.5;
  if (time.length < 4 * w) return [];

  const intervals: Array<{ at: number; dt: number }> = [];
  for (let i = w; i < time.length; i += w) {
    const dt = (time[i] - time[i - w]) / w;
    if (dt > 0) intervals.push({ at: time[i - w], dt });
  }
  if (intervals.length < 3) return [];

  const changes: number[] = [];
  for (let i = 1; i < intervals.length; i++) {
    const r = intervals[i].dt / intervals[i - 1].dt;
    if (r > ratio || r < 1 / ratio) changes.push(intervals[i].at);
  }
  if (!changes.length) return [];

  const dts = intervals.map((x) => x.dt);
  return [{
    check: 'cadence',
    severity: 'low',
    summary: `the reporting interval changes during the record, between `
      + `${humanDuration(Math.min(...dts))} and ${humanDuration(Math.max(...dts))}`,
    detail: 'Compared as a ratio rather than a difference, so the step from 1 to 2 '
      + 'minutes counts as much as the one from 30 to 60. It matters because it '
      + 'changes what every other statistic over the whole record means — a mean '
      + 'across a rate change is not an average of anything in particular, and a '
      + 'spectrum across one is nonsense.',
    start: changes[0],
    end: changes[changes.length - 1],
    count: changes.length,
    marks: sample(changes, MAX_MARKS),
  }];
}

/* ---------------------------------------------------------------- bits -- */

/** Thin a list of event times down to a cap, keeping the ends and spreading
    the rest evenly. The count reported alongside is always the true one. */
export function sample(times: readonly number[], cap: number): number[] {
  if (times.length <= cap) return [...times];
  const step = times.length / cap;
  const out: number[] = [];
  for (let i = 0; i < cap; i++) out.push(times[Math.floor(i * step)]);
  out[out.length - 1] = times[times.length - 1];
  return out;
}

export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'an unknown time';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

const isoTime = (t: number): string =>
  (Number.isFinite(t) ? `${new Date(t * 1000).toISOString().slice(0, 19)}Z` : 'an unknown time');
const isoDay = (t: number): string =>
  (Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 10) : 'an unknown day');

export { isoTime, isoDay };
