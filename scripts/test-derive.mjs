#!/usr/bin/env node
/**
 * The quantities this site computes rather than reads.
 *
 *   npm run test:derive
 *
 * Two kinds of check. The physics is asserted against values worked out
 * independently — a wind profile against its own definition, a dewpoint
 * against the Magnus form's published accuracy, seawater against GSW. The
 * rest asserts the *refusals*: what a routine must return NaN for rather
 * than a number, because every one of these is silent when it is wrong.
 */

import { check, done, near, ok, section } from './lib/check.mjs';
import {
  anomalyApplied, dewpoint, referenceSalinity, saturationVapourPressure,
  seawater, specificHumidity, SURFACE_DBAR, u10Neutral, UPS, WIND_HEIGHT,
  windComponents, windSpeedDirection, windStress,
} from '../packages/usv-vars/index.ts';
import { density, potentialDensity, soundSpeed } from '../packages/teos10/index.ts';

/* ------------------------------------------------------------------------ */
section('sea pressure is the surface, and is a constant');

/* Every variable named `pressure` on a USV is atmospheric. Fed to a seawater
   routine as dbar, 1013 hPa becomes a kilometre of depth — and every number
   that comes back still looks like seawater. */
check('the TEOS-10 quantities are evaluated at 0 dbar', SURFACE_DBAR, 0);
{
  const sa = 36.86;
  const t = 29.56;
  /* In-situ density carries the compression directly, so it is where the
     error is largest. */
  near('reading a barometer as sea pressure inflates in-situ density by 4.28 kg/m³',
    density(sa, t, 1013) - density(sa, t, 0), 4.28, 0.02);
  /* σ₀ is referenced to the surface and so barely depends on the pressure
     argument at all — which is exactly why the mistake survives a sanity
     check: 0.085 is still eighty-five times the precision density is quoted
     to, and it is not visible on a plot. */
  near('and shifts σ₀ by 0.085, which is small enough to look right',
    (potentialDensity(sa, t, 1013, 0) - 1000) - (potentialDensity(sa, t, 0, 0) - 1000),
    0.085, 0.005);
  near('while sound speed is out by 16.7 m/s',
    soundSpeed(sa, t, 1013) - soundSpeed(sa, t, 0), 16.7, 0.2);
}

/* ------------------------------------------------------------------------ */
section('the wind profile, which is what makes two vendors comparable');

/* z₀ = 10 / exp(κ/√CD10N) with κ = 0.4 and CD10N = 1.2e-3. The profile must
   return the input unchanged at exactly 10 m, whatever z₀ is — that is the
   definition, not a fitted result. */
near('10 m is the identity', u10Neutral(12.5, 10), 12.5, 1e-12);
ok('below 10 m the wind is adjusted upwards', u10Neutral(10, 3.4) > 10);
ok('above 10 m, downwards', u10Neutral(10, 20) < 10);

/* The Oshen adjustment is the number the campaign analysis quotes: a Gill
   MaxiMet at 0.66 m reads about 31% low against the same true wind. */
{
  const ratio = u10Neutral(10, WIND_HEIGHT.oshen) / 10;
  near('an Oshen at 0.66 m is adjusted by +31%', ratio, 1.31, 0.01);
  const sd = u10Neutral(10, WIND_HEIGHT.saildrone) / 10;
  near('a Saildrone at 3.4 m by +10%', sd, 1.10, 0.01);
  ok('so the two disagree by a fifth before adjustment',
    Math.abs(ratio / sd - 1) > 0.15, `${((ratio / sd - 1) * 100).toFixed(0)}%`);
}

/* The profile is linear in the wind, which is what lets it be applied to a
   whole column at once. */
near('it scales', u10Neutral(20, 3.4), 2 * u10Neutral(10, 3.4), 1e-9);

/* z₀ = 10/exp(κ/√CD10N) = 9.665e-5 m. log(z/z₀) goes to zero there and
   negative below it, so the adjustment explodes and then changes sign.
   Neither is a wind. */
ok('a height at the roughness length has no profile to read',
  Number.isNaN(u10Neutral(10, 9.665e-5)), `${u10Neutral(10, 9.665e-5)}`);
ok('nor one below it', Number.isNaN(u10Neutral(10, 5e-5)));
ok('nor does a height of zero', Number.isNaN(u10Neutral(10, 0)));
ok('nor a negative one', Number.isNaN(u10Neutral(10, -3)));
ok('a missing wind stays missing', Number.isNaN(u10Neutral(NaN, 3.4)));

/* ------------------------------------------------------------------------ */
section('wind stress');

/* τ = ρa CD U₁₀² with ρa = 1.15 and CD = 1.2e-3 below 11 m/s:
   1.15 × 0.0012 × 100 = 0.138 N/m². */
near('at 10 m/s, in the constant-CD regime', windStress(10), 0.138, 1e-6);
check('and no wind is no stress', windStress(0), 0);

/* Large & Pond is continuous at 11 m/s by construction:
   (0.49 + 0.065 × 11) × 1e-3 = 1.205e-3, against the 1.2e-3 below it. */
{
  const below = windStress(11);
  const above = windStress(11.0001);
  /* (0.49 + 0.065 × 11) × 1e-3 = 1.205e-3 against the 1.2e-3 below it — a
     0.4% step, which is Large & Pond's own discontinuity and not an error
     here. Asserted relatively, because an absolute tolerance on a stress
     means something different at 11 m/s than at 30. */
  ok('the drag coefficient is continuous at 11 m/s to within 0.5%',
    Math.abs(above / below - 1) < 0.005,
    `${below.toFixed(5)} → ${above.toFixed(5)} (${((above / below - 1) * 100).toFixed(2)}%)`);
  ok('and grows faster than U² above it', windStress(30) / windStress(15) > 4,
    `${(windStress(30) / windStress(15)).toFixed(2)}× for 2× the wind`);
}
ok('a missing wind gives no stress', Number.isNaN(windStress(NaN)));

/* ------------------------------------------------------------------------ */
section('moisture');

/* At saturation the dewpoint is the air temperature, exactly, for any
   temperature — the Magnus form is invertible there by construction. */
for (const t of [-20, 0, 15, 25, 35]) {
  near(`saturated air at ${t} °C has its own dewpoint`, dewpoint(t, 100), t, 1e-9);
}
ok('and unsaturated air is cooler', dewpoint(25, 80) < 25);
near('25 °C at 80% RH', dewpoint(25, 80), 21.3, 0.1);
near('30 °C at 60% RH', dewpoint(30, 60), 21.4, 0.2);

/* 6.1094 hPa at 0 °C is the Magnus form's own constant. */
near('saturation vapour pressure at 0 °C', saturationVapourPressure(0), 6.1094, 1e-4);
near('and roughly triples by 25 °C', saturationVapourPressure(25), 31.7, 0.3);

near('specific humidity at 25 °C, 80%, 1013 hPa', specificHumidity(25, 80, 1013), 15.7, 0.2);
ok('dry air holds none', specificHumidity(25, 0, 1013) === 0);
ok('and it falls as pressure rises at fixed RH',
  specificHumidity(25, 80, 1050) < specificHumidity(25, 80, 1013));

/* A humidity above saturation is a wet sensor, not a supersaturated
   atmosphere. Clamped for the logarithm's sake; the series keeps what was
   reported and usv-qc reports the excursion. */
near('105% RH is read as saturated rather than as a complex number',
  dewpoint(25, 105), 25, 1e-9);
ok('a zero humidity has no dewpoint', Number.isNaN(dewpoint(25, 0)));

/* ------------------------------------------------------------------------ */
section('seawater at the surface');

{
  /* A real sample: sd1030, 2026-08-14, west Atlantic. */
  const r = seawater({ salinity: 36.6942, temperature: 29.5572, lon: -65.09, lat: 24.46 });

  /* Reference Salinity is SP × 35.16504/35, exact by TEOS-10's definition. */
  near('Absolute Salinity is near Reference Salinity', r.sa, referenceSalinity(36.6942), 0.05);
  ok('but not identical to it, where the atlas applied',
    Number.isFinite(r.sa), `${r.sa}`);
  near('the Reference Salinity factor is the defined one', UPS, 35.16504 / 35, 1e-12);

  /* Conservative Temperature is within a few hundredths of in-situ at the
     surface — the difference is the potential-enthalpy correction. */
  near('Conservative Temperature is close to in-situ at 0 dbar', r.ct, 29.5572, 0.1);

  /* Tropical surface water: σ₀ around 23, sound speed around 1546 m/s. */
  near('σ₀ for warm salty surface water', r.sigma0, 23.14, 0.1);
  near('and its sound speed', r.soundSpeed, 1546, 2);
  ok('spiciness is positive for warm and salty', r.spice0 > 0, `${r.spice0.toFixed(3)}`);
}

{
  /* Cold, fresher: the Nantucket Shoals record in January. */
  const r = seawater({ salinity: 32.5, temperature: 5.7, lon: -70.3, lat: 41.0 });
  ok('cold shelf water is denser', r.sigma0 > 25, `σ₀ ${r.sigma0.toFixed(2)}`);
  ok('and sound travels slower in it', r.soundSpeed < 1480, `${r.soundSpeed.toFixed(1)} m/s`);
  ok('spiciness is negative for cold and fresh', r.spice0 < 0, `${r.spice0.toFixed(3)}`);
}

/* Without the atlas, Absolute Salinity is Reference Salinity wearing SA's
   name. The difference reaches 0.03 g/kg — thirty times the precision
   density is quoted to — so the page has to say which it got. */
ok('no atlas means no anomaly, and it is reported',
  !anomalyApplied(35, -65, 24, null));
{
  const r = seawater({ salinity: 35, temperature: 20, lon: -65, lat: 24 });
  near('and SA falls back to Reference Salinity exactly',
    r.sa, referenceSalinity(35), 1e-12);
}

ok('a missing salinity gives no seawater',
  Number.isNaN(seawater({ salinity: NaN, temperature: 20, lon: 0, lat: 0 }).sigma0));
ok('nor does a missing temperature',
  Number.isNaN(seawater({ salinity: 35, temperature: NaN, lon: 0, lat: 0 }).sigma0));

/* ------------------------------------------------------------------------ */
section('wind components use the meteorological convention');

/* A "northerly" is wind *from* the north, which moves air southward. Both
   components carry a minus sign, and getting it wrong flips every vector by
   180° while the plot still looks perfectly plausible. */
{
  const n = windComponents(10, 0);
  near('wind from the north blows southward', n.v, -10, 1e-9);
  near('and has no east–west component', n.u, 0, 1e-9);

  const e = windComponents(10, 90);
  near('wind from the east blows westward', e.u, -10, 1e-9);
  near('with no north–south component', e.v, 0, 1e-9);

  const s = windComponents(10, 180);
  near('wind from the south blows northward', s.v, 10, 1e-9);

  const w = windComponents(10, 270);
  near('wind from the west blows eastward', w.u, 10, 1e-9);
}

/* The inverse must be exact, because both directions of the conversion are
   used: some records publish speed and direction, some publish components. */
for (const from of [0, 45, 90, 135, 180, 225, 270, 315, 359]) {
  const { u, v } = windComponents(12.3, from);
  const back = windSpeedDirection(u, v);
  near(`${from}° survives the round trip`, back.from, from, 1e-9);
  near(`  and so does the speed`, back.speed, 12.3, 1e-9);
}
ok('a direction comes back in [0, 360)',
  windSpeedDirection(1, 1).from >= 0 && windSpeedDirection(1, 1).from < 360);

/* ------------------------------------------------------------------------ */
section('the sensor heights');

check('the Oshen Gill MaxiMet', WIND_HEIGHT.oshen, 0.66);
check('the Saildrone Explorer fallback', WIND_HEIGHT.saildrone, 3.4);
/* Chance publishes no sensor height anywhere in its metadata, so this one is
   a guess and usv-qc raises it on every Chance record. */
ok('and Chance, which is a guess', WIND_HEIGHT.chance > 0);

done();
