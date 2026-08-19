#!/usr/bin/env node
/**
 * The canonicalization, against every naming era in the archive.
 *
 *   npm run test:vars
 *
 * The load-bearing assertion here is the first one in each group: **the same
 * measurement, published under four different names by three vendors across
 * nine years, resolves to one canonical quantity.** Everything the campaign
 * page does rests on that, and nothing else in the repository checks it.
 */

import fs from 'node:fs';
import { check, done, ok, section } from './lib/check.mjs';
import { parseInfo } from '../packages/erddap-pmel/index.ts';
import {
  BY_KEY, CHUNK_SECONDS, chunkOf, chunkPath, chunksFor, chunkSpan,
  conversionFor, DEFAULT_STACK, isKnownUnit, QUANTITIES, resolveDataset,
  resolveVariable, seasonOf, sensorOf, shardFor, splitStatistic, unitFault,
} from '../packages/usv-vars/index.ts';
import { COLORMAPS } from '../packages/plot/index.ts';

const json = (name) => JSON.parse(
  fs.readFileSync(new URL(`./fixtures/erddap/${name}`, import.meta.url), 'utf8'));

/** Resolve a bare column name, as if it had no metadata at all. */
const bare = (name, units, standardName) =>
  resolveVariable({ name, type: 'double', units, standardName, ancillary: false });

/* ------------------------------------------------------------------------ */
section('every colormap named here actually ships');

/* `sample()` falls back to viridis for a name it does not know rather than
   throwing, so a wrong name draws a perfectly good plot in entirely the
   wrong colours and nothing anywhere says so. The first draft of
   quantity.ts named five maps that do not exist — cmo.phase, cmo.amp,
   cmo.tempo, cmo.oxy, cmo.topo — and every one of them would have shipped. */
{
  const missing = QUANTITIES.filter((q) => !(q.colormap in COLORMAPS));
  ok('no quantity names a colormap that is not in the table',
    missing.length === 0,
    missing.map((q) => `${q.key} → ${q.colormap}`).join(', ') || 'all present');
}

/* A bearing wraps: 359° and 1° must come out nearly the same colour, and
   every sequential map puts them at opposite ends of the ramp. */
for (const q of QUANTITIES.filter((q) => q.circular)) {
  check(`${q.key} is drawn in a cyclic colormap`, q.colormap, 'hsv');
}

/* ------------------------------------------------------------------------ */
section('the quantity table is internally consistent');

{
  const keys = QUANTITIES.map((q) => q.key);
  check('every key is unique', new Set(keys).size, keys.length);
  ok('every quantity has a label and a short form',
    QUANTITIES.every((q) => q.label.length > 0 && q.short.length > 0));
  ok('no short form is long enough to reflow a readout',
    QUANTITIES.every((q) => q.short.length <= 8),
    QUANTITIES.filter((q) => q.short.length > 8).map((q) => q.short).join(', ') || 'all short');
  ok('every default-stack entry exists', DEFAULT_STACK.every((k) => BY_KEY.has(k)),
    DEFAULT_STACK.filter((k) => !BY_KEY.has(k)).join(', ') || 'all present');

  /* A floor is a defence against a sensor's dark counts, never a statement
     about the ocean. Temperature reaches below zero and the wind components
     are signed by construction, so a floor on either would be a lie. */
  for (const key of ['air_temperature', 'sea_temperature', 'skin_temperature',
    'wind_east', 'wind_north', 'wind_vertical', 'ct', 'spice0']) {
    ok(`${key} has no floor, because it really is signed`,
      BY_KEY.get(key)?.floor === undefined);
  }
  for (const key of ['wind_speed', 'salinity', 'chlorophyll', 'oxygen_concentration',
    'relative_humidity', 'wave_height', 'par']) {
    check(`${key} cannot go below zero`, BY_KEY.get(key)?.floor, 0);
  }
}

/* ------------------------------------------------------------------------ */
section('the statistic and the averaging word are parsed off, not enumerated');

check('a plain mean', splitStatistic('TEMP_AIR_MEAN').stem, 'temp_air');
check('and its statistic', splitStatistic('TEMP_AIR_MEAN').statistic, 'mean');
check('a standard deviation keeps its stem', splitStatistic('TEMP_AIR_STDDEV').stem, 'temp_air');
check('and reports itself', splitStatistic('TEMP_AIR_STDDEV').statistic, 'stddev');
/* `_FILTERED_` is the vendors' word for "averaged over the reporting
   interval" and means what `_MEAN` does. Dropped after the statistic, so a
   `_FILTERED_STDDEV` keeps its stddev. */
check('_FILTERED_ is dropped', splitStatistic('RH_FILTERED_MEAN').stem, 'rh');
check('but not the statistic behind it',
  splitStatistic('RH_FILTERED_STDDEV').statistic, 'stddev');
check('and the stem is the same either way',
  splitStatistic('RH_FILTERED_STDDEV').stem, 'rh');
check('a trailing _filtered', splitStatistic('sbe37_temperature_filtered').stem,
  'sbe37_temperature');
check('a bare column is the measurement', splitStatistic('SOG').statistic, 'mean');
check('peak is its own statistic', splitStatistic('ROLL_FILTERED_PEAK').statistic, 'peak');
check('and Saildrone RMS is a standard deviation by another name',
  splitStatistic('baro_pressure_rms').statistic, 'stddev');

/* ------------------------------------------------------------------------ */
section('the same measurement, four naming eras, one quantity');

/** Every spelling of one quantity across the archive. */
const ERAS = {
  air_temperature: [
    ['TEMP_AIR_MEAN', 'Saildrone 2017–2024'],
    ['air_temperature_filtered', 'Saildrone 2026'],
    ['air_temperature_mean', 'Oshen'],
    ['TEMP_AIR_FILTERED_MEAN', 'Chance 2026'],
    ['TEMP_AIR', 'bare'],
  ],
  sea_temperature: [
    ['TEMP_CTD_MEAN', 'Saildrone 2017'],
    ['TEMP_SBE37_MEAN', 'Saildrone 2021–2024'],
    ['sbe37_temperature_filtered', 'Saildrone 2026'],
    ['sst_mean', 'Oshen 2026'],
    ['sea_surface_temperature_mean', 'Oshen 2025'],
    ['TEMP_SEA_FILTERED_MEAN', 'Chance 2026'],
  ],
  air_pressure: [
    ['BARO_PRES_MEAN', 'Saildrone'],
    ['baro_pressure_filtered', 'Saildrone 2026'],
    ['air_pressure_mean', 'Oshen'],
    ['BARO_PRES_FILTERED_MEAN', 'Chance'],
  ],
  wind_speed: [
    ['WIND_SPEED_MEAN', 'Saildrone 2021–2024'],
    ['wind_speed_world_filtered', 'Saildrone 2026'],
    ['wind_speed_mean_motion_corrected', 'Oshen 2026'],
    ['wind_speed_mean', 'Oshen 2025'],
    ['WIND_SPEED_PLATFORM_FILTERED_MEAN', 'Chance'],
  ],
  wind_gust: [
    ['GUST_WND_MEAN', 'Saildrone'],
    ['wind_gust_filtered', 'Saildrone 2026'],
    ['wind_speed_max_motion_corrected', 'Oshen 2026'],
    /* Oshen 2025 spells its gust as the CF standard name itself. Eight
       datasets, and it was the one real miss in the first draft. */
    ['wind_speed_of_gust', 'Oshen 2025'],
  ],
  salinity: [
    ['SAL_MEAN', 'Saildrone 2017'],
    ['SAL_SBE37_MEAN', 'Saildrone 2021–2024'],
    ['sbe37_practical_salinity_filtered', 'Saildrone 2026'],
  ],
  chlorophyll: [
    ['CHLOR_MEAN', 'Saildrone 2017'],
    ['CHLOR_WETLABS_MEAN', 'Saildrone 2021–2024'],
    ['fluoro_chlorophyll_filtered', 'Saildrone 2026'],
    ['CHLOR_FILTERED_MEAN', 'Chance'],
  ],
  speed_over_ground: [
    ['SOG', 'every era'],
    ['SOG_FILTERED_MEAN', 'Saildrone/Chance'],
    ['speed_over_ground_mean', 'Saildrone 2026'],
  ],
  relative_humidity: [
    ['RH_MEAN', 'Saildrone'],
    ['relative_humidity_filtered', 'Saildrone 2026'],
    ['relative_humidity_mean', 'Oshen'],
    ['RH_FILTERED_MEAN', 'Chance'],
  ],
};

for (const [key, spellings] of Object.entries(ERAS)) {
  for (const [name, era] of spellings) {
    check(`${name} (${era}) → ${key}`, bare(name).quantity?.key, key);
  }
}

/* ------------------------------------------------------------------------ */
section('a standard_name resolves a name nobody anticipated');

check('an unknown column with a good standard name still lands',
  bare('SOME_NEW_SENSOR_2031_MEAN', 'degree_C', 'sea_water_temperature').quantity?.key,
  'sea_temperature');
ok('and one with neither resolves to nothing rather than to a guess',
  bare('MYSTERY_COLUMN', 'volts').quantity === undefined);

/* ------------------------------------------------------------------------ */
section('a standard_name never outranks a name this file knows');

/* TEMP_LW_MEAN is the longwave radiometer's own body temperature and is
   published as standard_name: air_temperature. Counted as canonical it puts
   the inside of an instrument on the same axis as the atmosphere, several
   degrees off, with nothing to say which was which. */
{
  const lw = bare('TEMP_LW_MEAN', '¡C', 'air_temperature');
  ok('the radiometer body temperature does not become air temperature',
    lw.quantity === undefined);
  ok('and it says why', lw.faults.some((f) => /body temperature/.test(f)),
    lw.faults.join(' | '));
}

/* ------------------------------------------------------------------------ */
section('which sensor took it');

check('an SBE37', sensorOf('TEMP_SBE37_MEAN'), 'SBE37');
check('an RBR CODA', sensorOf('rbr_coda_t_temperature_filtered'), 'RBR');
check('an Aanderaa optode', sensorOf('O2_CONC_AANDERAA_MEAN'), 'Aanderaa');
check('the half-metre thermistor', sensorOf('TEMP_DEPTH_HALFMETER_MEAN'), '0.5 m');
check('and a column that names none', sensorOf('BARO_PRES_MEAN'), '');

{
  /* A 2021-era record carries four sea temperatures, one of which is the
     thermistor inside the oxygen optode. A reader picking "Temperature"
     from four identical menu entries has no way to know which they got. */
  const vars = ['TEMP_SBE37_MEAN', 'TEMP_CTD_RBR_MEAN', 'TEMP_DEPTH_HALFMETER_MEAN',
    'TEMP_O2_RBR_MEAN'].map((name) => ({
    name, type: 'double', units: 'degree_C',
    standardName: 'sea_water_temperature', ancillary: false,
  }));
  const r = resolveDataset(vars);
  check('all four resolve to sea temperature', r.byQuantity.get('sea_temperature').length, 4);

  /* Asserted explicitly, because the ranking below cannot be trusted to
     fail when this does: with every sensor unrecognised the scores tie and
     a stable sort returns whatever order the dataset happened to list. The
     first draft matched with `\b`, which does not fire between `_` and a
     letter, and that is exactly what happened. */
  for (const [column, sensor] of [['TEMP_SBE37_MEAN', 'SBE37'],
    ['TEMP_CTD_RBR_MEAN', 'RBR'], ['TEMP_DEPTH_HALFMETER_MEAN', '0.5 m']]) {
    check(`  ${column} is recognised as ${sensor}`,
      r.byQuantity.get('sea_temperature').find((c) => c.column === column).sensor, sensor);
  }
  check('the pumped CTD is the primary one',
    r.primary.get('sea_temperature').column, 'TEMP_SBE37_MEAN');

  const group = r.byQuantity.get('sea_temperature');
  const optode = group.find((c) => c.column === 'TEMP_O2_RBR_MEAN');
  ok('the optode housekeeping thermistor is ranked last',
    group[group.length - 1] === optode, group.map((c) => c.column).join(' < '));

  /* Two identical entries in a menu is the failure the sensor business
     exists to prevent. */
  /* Two of these four are RBR instruments — the CTD's and the oxygen
     optode's — so naming by sensor alone gives two entries reading "Sea
     water temperature (RBR)". Uniqueness is settled over the whole set. */
  const labels = group.map((c) => c.label);
  check('every label is distinct', new Set(labels).size, labels.length);
  check('and the primary keeps the plain name', labels[0], 'Sea water temperature');
  ok('the others name their instrument or their column',
    labels.slice(1).every((l) => /\(/.test(l)), labels.join(' · '));
  ok('the colliding pair falls back to the column name',
    labels.filter((l) => /TEMP_\w+_RBR_MEAN/.test(l)).length === 2, labels.join(' · '));
}

/* ------------------------------------------------------------------------ */
section('units: respelled, converted, or reported');

check('a respelling is not a conversion', conversionFor('m_per_sec').converts, false);
check('and lands on the canonical string', conversionFor('m_per_sec').units, 'm/s');
check('every spelling of conductivity agrees',
  conversionFor('milliS cm-1').units, conversionFor('mS_per_cm').units);

/* Every Oshen in the archive publishes wind in knots and every other vehicle
   in m/s. On one axis unconverted, the Oshen looks like it is in twice the
   wind the Saildrone beside it is in. */
{
  const knots = conversionFor('knot');
  ok('knots are converted', knots.converts);
  check('to m/s', knots.units, 'm/s');
  ok('at the exact factor', Math.abs(knots.factor - 0.514444) < 1e-9, `${knots.factor}`);
  ok('so 20 knots is 10.3 m/s', Math.abs(20 * knots.factor - 10.28888) < 1e-4);
}
{
  /* Chance's Airmar wind direction is the only radian column in the archive. */
  const rad = conversionFor('radians');
  ok('radians are converted', rad.converts);
  ok('and π is 180°', Math.abs(Math.PI * rad.factor - 180) < 1e-9);
}

/* Salinity is dimensionless and the archive says so four ways. "35.2 PSU"
   and "35.2 1" are both worse than "35.2" under an axis already labelled
   Practical salinity. */
for (const u of ['PSU', 'PSS-78', '1', '']) {
  check(`${u || '(empty)'} prints as nothing`, conversionFor(u).units, '');
}

/* A CF time unit is an epoch definition, which is true, machine-readable
   and absurd under an axis whose ticks already read as dates. */
check('an epoch definition is not a unit',
  conversionFor('seconds since 1970-01-01T00:00:00Z').units, '');

ok('an unrecognised unit passes through rather than being guessed at',
  conversionFor('furlongs per fortnight').units === 'furlongs per fortnight');
ok('and is reported as unknown', !isKnownUnit('furlongs per fortnight'));
ok('while a known one is not', isKnownUnit('hPa'));

/* ------------------------------------------------------------------------ */
section('units that are damaged rather than absent');

/* U+00A1 is the degree sign in Mac Roman, so `¡C` is `°C` written there and
   read back as Latin-1. Two datasets carry it. */
ok('mis-decoded text is caught', unitFault('¡C').length > 0, unitFault('¡C'));
ok('and named by code point', /U\+00A1/.test(unitFault('¡C')));

/* Written the other way round — matching the damage rather than the
   legitimate set — is how `m s-1` ends up flagged for its hyphen. */
for (const good of ['m s-1', '°C', 'µmol/L', 'W/m²', 'm⁻¹ sr⁻¹',
  'hPa', 'percent', '', 'mS cm-1']) {
  check(`${good || '(empty)'} is not damaged`, unitFault(good), '');
}

/* ------------------------------------------------------------------------ */
section('units missing entirely');

{
  /* Chance publishes no units at all on pressure, chlorophyll and the wind
     components. The quantity says what they must be; that is an inference,
     and it is reported rather than assumed silently. */
  const baro = bare('BARO_PRES_FILTERED_MEAN', undefined, 'air_pressure');
  check('it still resolves', baro.quantity?.key, 'air_pressure');
  ok('and says the units were inferred',
    baro.faults.some((f) => /no units published/.test(f)), baro.faults.join(' | '));
  /* Guessing a *conversion* would be a different and much worse thing than
     guessing a label: the values are 1002, which is hPa already. */
  check('with no conversion invented', baro.conversion.factor, 1);
}

/* ------------------------------------------------------------------------ */
section('against every real dataset in the archive');

for (const [file, id, expect] of [
  ['info-sd1030_hurricane_2026.json', 'sd1030_hurricane_2026',
    ['air_pressure', 'wind_speed', 'sea_temperature', 'salinity', 'wave_height',
      'chlorophyll', 'oxygen_concentration', 'skin_temperature', 'par']],
  ['info-oshenPD11_hurricane_2026.json', 'oshenPD11_hurricane_2026',
    ['air_pressure', 'air_temperature', 'relative_humidity', 'wind_speed',
      'wind_gust', 'wind_direction', 'sea_temperature']],
  ['info-oshenPC3_hurricane_2025.json', 'oshenPC3_hurricane_2025',
    ['air_pressure', 'air_temperature', 'relative_humidity', 'wind_speed',
      'wind_gust', 'sea_temperature']],
  ['info-chanceMC29_NEFSC_nantucket_2026_nrt.json', 'chanceMC29_NEFSC_nantucket_2026_nrt',
    ['air_pressure', 'air_temperature', 'relative_humidity', 'sea_temperature',
      'chlorophyll', 'cdom', 'speed_over_ground', 'heading', 'pitch', 'roll']],
  ['info-sd1005_2017.json', 'sd1005_2017',
    ['air_pressure', 'air_temperature', 'sea_temperature', 'salinity',
      'conductivity', 'chlorophyll', 'cdom', 'shortwave_down', 'longwave_down']],
  ['info-all_swfsc_2023.json', 'all_swfsc_2023',
    ['air_pressure', 'wind_speed', 'sea_temperature', 'salinity', 'wave_height']],
]) {
  const info = parseInfo(id, json(file));
  const r = resolveDataset(info.variables);
  const missing = expect.filter((k) => !r.primary.has(k));
  ok(`${id} carries the quantities it should`, missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : `${r.primary.size} quantities`);

  const total = r.columns.length;
  const named = r.columns.filter((c) => c.quantity).length;
  ok(`  and most of its columns resolve`, named / total > 0.75,
    `${named}/${total} = ${(100 * named / total).toFixed(0)}%`);
}

/* Oshen's humidity declares `units = 1` and publishes percent, so a
   conversion here would be the wrong fix — there is nothing to multiply by.
   The values settle it and usv-qc reports it. */
{
  const info = parseInfo('oshenPD11_hurricane_2026', json('info-oshenPD11_hurricane_2026.json'));
  const r = resolveDataset(info.variables);
  const rh = r.primary.get('relative_humidity');
  check('Oshen humidity is published dimensionless', rh.publishedUnits, '1');
  check('and nothing is multiplied by anything', rh.conversion.factor, 1);

  const wind = r.primary.get('wind_speed');
  check('while its wind really is converted', wind.conversion.converts, true);
  check('from knots', wind.publishedUnits, 'knot');
}

/* ------------------------------------------------------------------------ */
section('where a record\'s full-rate data lives');

/* The site is one repository; the full-rate data is 794 MB against a 1 GB
   Pages limit, so it lives one repository per season. They are project sites
   under the same organisation and custom domain, so they are the *same
   origin* as the site — which is why the detail tier costs no CORS and no
   widening of `connect-src 'self'`. */
check('a 2026 record', shardFor('hurricane-2026'), 'usv-data-2026');
check('a 2017 one', shardFor('tpos-2017'), 'usv-data-2017');
/* A deployment that ran into January belongs to the season it launched in,
   which its campaign already records. */
check('and one that ran into the new year', shardFor('hurricane-2024'), 'usv-data-2024');
check('a campaign with no year is not silently filed under one',
  shardFor('other'), 'usv-data-undated');
check('the season alone', seasonOf('bering-pollock-2020'), '2020');

/* ------------------------------------------------------------------------ */
section('chunking the full-rate data');

check('a week', CHUNK_SECONDS, 7 * 86400);

/* Counted from the epoch, not from the record's own start, so a boundary is
   the same instant for every record and does not move when a mission's first
   row changes — a record that gains earlier data keeps every chunk it had. */
{
  const t = Date.parse('2026-08-14T00:00:00Z') / 1000;
  check('a timestamp lands in a chunk', chunkOf(t), Math.floor(t / (7 * 86400)));
  const span = chunkSpan(chunkOf(t));
  ok('whose span contains it', span.from <= t && t < span.to,
    `${span.from} <= ${t} < ${span.to}`);
  check('and is exactly a week wide', span.to - span.from, CHUNK_SECONDS);
  ok('and abuts the next without overlap',
    chunkSpan(chunkOf(t) + 1).from === span.to);
}

{
  const day = 86400;
  const t0 = 1_786_665_600;
  check('a window inside one chunk needs one', chunksFor(t0, t0 + 3600).length, 1);
  /* Inclusive of both ends: a reader's window is a closed interval and the
     sample at its last instant is one they asked for. */
  const three = chunksFor(t0, t0 + 15 * day);
  ok('a fifteen-day window needs three', three.length === 3, `${three}`);
  ok('and they are consecutive', three.every((c, i) => i === 0 || c === three[i - 1] + 1));
  check('a backwards window needs none', chunksFor(t0 + 100, t0).length, 0);
  check('an unreadable one likewise', chunksFor(NaN, t0).length, 0);
  check('an instant needs the chunk it is in', chunksFor(t0, t0).length, 1);
}

/* A sibling project site under the same domain, so the path climbs out of
   this site's base and back down into the shard's. */
{
  const p = chunkPath('usv-data-2026', 'sd1030_hurricane_2026', 12345);
  check('a chunk path', p, '../usv-data-2026/sd1030_hurricane_2026/12345.json.gz');
  ok('and an id with awkward characters is escaped',
    chunkPath('usv-data-2026', 'a b/c', 1).includes('a%20b%2Fc'));
}

done();
