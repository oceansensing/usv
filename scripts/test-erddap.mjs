#!/usr/bin/env node
/**
 * The PMEL client, against captured responses.
 *
 *   npm run test:erddap
 *
 * Entirely offline. Every fixture in `scripts/fixtures/erddap/` is a real
 * response taken on 2026-08-19; nothing here touches the network, so the
 * gate cannot fail because PMEL is having a bad morning — which is exactly
 * when you least want the deploy blocked.
 */

import fs from 'node:fs';
import { check, done, ok, section, throws } from './lib/check.mjs';
import {
  campaignOf, campaignYear, chooseRung, fetchWithRetry, intervalString, isActive,
  isFullRate,
  kindOf, LADDER, medianCadence, parseCatalog, parseInfo, parseIsoTime,
  parseJsonlCsv, tabledapUrl, variantOf, vehicleOf,
} from '../packages/erddap-pmel/index.ts';

const fixture = (name) =>
  fs.readFileSync(new URL(`./fixtures/erddap/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fixture(name));

/* ------------------------------------------------------------------------ */
section('time parsing knows both forms the server emits');

check('a 20-character stamp', parseIsoTime('2026-08-14T00:01:00Z'), 1786665660);
/* Every 2026 Saildrone record uses this form. The sibling glider client
   checks only for length 20, so on this archive its fast path would miss on
   the largest datasets in it — 324,843 rows apiece. */
check('a 24-character stamp with milliseconds',
  parseIsoTime('2026-08-14T00:00:00.000Z'), 1786665600);
check('milliseconds are kept', parseIsoTime('2026-08-14T00:00:00.500Z'), 1786665600.5);
check('the two forms agree at the same instant',
  parseIsoTime('2026-08-14T00:01:00.000Z'), parseIsoTime('2026-08-14T00:01:00Z'));
ok('an unparseable stamp is NaN, not a guess', Number.isNaN(parseIsoTime('not a time')));

/* ------------------------------------------------------------------------ */
section('query construction');

{
  const url = tabledapUrl('https://x/erddap', 'sd1030_hurricane_2026', 'jsonlCSV',
    ['time', 'latitude', 'sst_mean'], { start: 1786665600, end: 1786752000 });
  ok('the variable list is the unnamed first term, comma-separated',
    url.includes('?time,latitude,sst_mean&'), url);
  ok('>= is encoded and the operator survives', url.includes('time%3E=2026-08-14T00:00:00Z'));
  ok('<= likewise', url.includes('time%3C=2026-08-15T00:00:00Z'));
  ok('commas are never encoded', !url.includes('%2C'));
}

{
  const url = tabledapUrl('https://x/erddap', 'd', 'csv', ['time', 'a'],
    { every: '20minutes', start: 1786665600 });
  /* ERDDAP applies the orderBy after the constraints and rejects the query
     outright if a constraint follows it. */
  ok('orderByClosest comes last', url.endsWith('orderByClosest(%22time/20minutes%22)'), url);
  ok('and the constraint is before it',
    url.indexOf('time%3E=') < url.indexOf('orderByClosest'));
}

/* `orderByClosest("2hours")` without the column is a 400 — the argument is a
   CSV list of order-by columns *plus* an interval, so it needs two parts.
   Both accepted forms were confirmed against the live server. */
check('minutes below the hour', intervalString(20), '20minutes');
check('the singular is written', intervalString(1), '1minute');
check('hours above it, because the number must be an integer',
  intervalString(120), '2hours');
check('and the singular hour', intervalString(60), '1hour');
check('90 minutes stays in minutes rather than becoming 1.5hours',
  intervalString(90), '90minutes');

/* ------------------------------------------------------------------------ */
section('the decimation ladder is a multiple of five minutes');

/* A Saildrone's SBE37 reports every 5 minutes into a 1-minute record, so
   80.2% of full-rate rows carry no sea temperature. orderByClosest picks the
   row nearest each boundary — a rung that is a multiple of the sensor's own
   period lands on the reporting rows, one that is not lands between them.
   Measured: sea temperature is 80.2% missing at full rate and 0.8% missing
   at time/20minutes on the same window. */
for (const rung of LADDER) {
  if (rung <= 2) continue;
  check(`rung ${rung} divides by 5`, rung % 5, 0);
}
ok('the ladder is ascending', LADDER.every((v, i) => i === 0 || v > LADDER[i - 1]));

{
  const day = 86400;
  check('a 7-day Oshen at 5-minute cadence stays at its own rate',
    chooseRung(7 * day, 300), 5);
  check('a 30-day Saildrone fits at 1 minute', chooseRung(30 * day, 60), 1);
  /* 226 days at 1 minute is 325,440 rows, past the 150,000 budget; at 2 it is
     162,720, still past; 5 gives 65,088. */
  check('a 226-day record lands on 5 minutes', chooseRung(226 * day, 60), 5);
  check('the longest record in the archive, 431 days', chooseRung(431 * day, 60), 5);
  ok('the ladder never starts below the vehicle cadence',
    chooseRung(1 * day, 300) >= 5, `${chooseRung(1 * day, 300)}`);
}

ok('a rung at or below the cadence is not decimation at all', isFullRate(1, 60));
ok('and one above it is', !isFullRate(5, 60));

/* ------------------------------------------------------------------------ */
section('the catalog');

{
  const all = parseCatalog(json('catalog.json'));
  ok('every USV dataset is found', all.length > 150, `${all.length} datasets`);

  /* `allDatasets` carries a row for itself. Left in, it becomes a vehicle at
     the null island with a 1970 start date. */
  ok('the self-row is dropped', !all.some((d) => d.id === 'allDatasets'));
  /* A template is a worked example of a file format, not a deployment. */
  ok('the CO2 template is dropped', !all.some((d) => /template/.test(d.id)));

  const by = (id) => all.find((d) => d.id === id);
  check('a 2026 Saildrone', by('sd1030_hurricane_2026')?.vendor, 'saildrone');
  check('an Oshen', by('oshenPD11_hurricane_2026')?.vendor, 'oshen');
  check('a Chance', by('chanceMC29_NEFSC_nantucket_2026_nrt')?.vendor, 'chance');

  const vendors = new Set(all.map((d) => d.vendor));
  check('and nothing else got in', vendors.size, 3);

  /* Eleven Chance datasets are EDDTableFromFileNames listings whose columns
     are url/name/size — no observation anywhere. */
  const files = all.filter((d) => d.kind === 'files');
  check('the file listings are recognised', files.length, 11);
  ok('and they are all Chance', files.every((d) => d.vendor === 'chance'));

  const plottable = all.filter((d) => d.kind !== 'files');
  ok('what is left is the plottable archive', plottable.length > 140,
    `${plottable.length} records`);

  /* **A record that names no vehicle carries more than one**, and its track
     is not a track: three Saildrones surveying one box report in turn, so
     the path drawn through consecutive rows is a scribble no vehicle sailed.
     A speed test does not find them — the implied speed between interleaved
     fixes stays under what any of them could do — but the name does. */
  const multi = all.filter((d) => d.multiVehicle);
  ok('the multi-vehicle records are found', multi.length >= 10,
    multi.map((d) => d.id).join(', '));
  ok('and the named collections are among them',
    multi.some((d) => d.id === 'all_swfsc_2023')
    && multi.some((d) => d.id === 'fisheries_2020_all'));
  /* The one the name gives nothing away about, and the only record of the
     2018 Arctic met and ocean data. */
  ok('as is saildrone_arctic_2018, which no name rule would have caught',
    multi.some((d) => d.id === 'saildrone_arctic_2018'));
  ok('while every single-vehicle record is not',
    !all.find((d) => d.id === 'sd1030_hurricane_2026')?.multiVehicle
    && !all.find((d) => d.id === 'oshenPD11_hurricane_2026')?.multiVehicle);
}

/* ------------------------------------------------------------------------ */
section('a vehicle is named the way its operators name it');

check('a Saildrone from its id', vehicleOf('sd1030_hurricane_2026', ''), 'SD-1030');
check('a bare 2020 id', vehicleOf('sd1043', ''), 'SD-1043');
check('an Oshen', vehicleOf('oshenPD11_hurricane_2026', ''), 'PD11');
check('a 2025 Oshen', vehicleOf('oshenPC3_hurricane_2025', ''), 'PC3');
check('a Chance', vehicleOf('chanceMC29_NEFSC_nantucket_2026_nrt', ''), 'MC29');
/* The 2019 Arctic titles say "drone 1033" rather than "Saildrone 1033". */
check('a title that writes it as "drone NNNN"',
  vehicleOf('x', 'NOAA/PMEL 2019 Arctic Saildrone Mission, drone 1033'), 'SD-1033');
check('a collection has no single vehicle', vehicleOf('all_swfsc_2023', ''), '');

/* **A four-digit number after "Saildrone" is not always a hull number.**
   `saildrone_2019_arctic_flux` is titled "Saildrone 2019 Arctic Flux Data" —
   a multi-platform product for a season — and the first version read the
   year as a vehicle called SD-2019, which then had its own page. Every hull
   in this archive is 1005–1096. */
check('a year in a title is not a hull number',
  vehicleOf('saildrone_2019_arctic_flux', 'Saildrone 2019 Arctic Flux Data'), '');
check('nor in the 2017 one',
  vehicleOf('saildrone_2017_arctic_flux', 'Saildrone 2017 Arctic Flux Data'), '');
check('while a real hull still resolves',
  vehicleOf('x', 'NOAA PMEL TPOS 2017 NRT Saildrone 1005'), 'SD-1005');

/* ------------------------------------------------------------------------ */
section('a campaign is keyword-anchored, so a new season classifies itself');

check('the 2026 hurricane fleet',
  campaignOf('sd1030_hurricane_2026', 'NOAA AOML PMEL Hurricane Monitoring 2026 Saildrone 1030', 0).slug,
  'hurricane-2026');
check('a season that does not exist yet',
  campaignOf('sd9999_hurricane_2031', 'NOAA AOML PMEL Hurricane Monitoring 2031 Saildrone 9999', 0).slug,
  'hurricane-2031');
check('TPOS', campaignOf('sd1005_2017', 'NOAA PMEL TPOS 2017 NRT Saildrone 1005', 0).slug,
  'tpos-2017');
check('the Nantucket survey',
  campaignOf('chanceMC29_NEFSC_nantucket_2026_nrt',
    'NOAA NEFSC Nantucket Shoals USV Survey 2026 Chance Maritime MC29', 0).slug,
  'nantucket-2026');
check('ECMWF is the Gulf Stream mission',
  campaignOf('sd1091_ecmwf_ags_2021', 'ECMWF Atlantic Gulf Stream 2021 NRT Saildrone 1091', 0).slug,
  'gulf-stream-2021');
check('the label reads as a person would write it',
  campaignOf('x', 'NOAA AOML PMEL Hurricane Monitoring 2026 Saildrone 1030', 0).label,
  'Hurricane Monitoring 2026');

/* A deployment that ran into January belongs to the season it launched in,
   which its title records and its start date does not. */
check('the year comes from the title, not the record',
  campaignYear('sd1041_hurricane_2024',
    'NOAA AOML PMEL Hurricane Monitoring 2024 Saildrone 1041',
    Date.parse('2025-02-05T00:00:00Z') / 1000),
  '2024');

check('a file listing is not plottable',
  kindOf('chanceMC29_NEFSC_nantucket_2026_ctd', 'CTD Casts', 'Other'), 'files');
check('a flux product is derived',
  kindOf('saildrone_2019_arctic_flux', 'Saildrone 2019 Arctic Flux Data', 'TimeSeries'),
  'derived');
check('a collection', kindOf('all_swfsc_2023', 'NOAA SWFSC 2023 Collection Saildrone', 'Trajectory'),
  'collection');
check('a vehicle record', kindOf('sd1030_hurricane_2026', 'Saildrone 1030', 'Trajectory'),
  'trajectory');

/* One vehicle-season is one deployment; counting the strap-on radiometer as
   a second makes every fleet total wrong. */
check('a strap-on radiometer is a variant', variantOf('sd1052_tpos_2022_LWR'), 'lwr');
check('the high-resolution twin', variantOf('chanceMC40_NEFSC_outershelf_2026_fullres'),
  'fullres');
check('and the main record is not', variantOf('sd1030_hurricane_2026'), '');

/* ------------------------------------------------------------------------ */
section('dataset metadata');

{
  const sd = parseInfo('sd1030_hurricane_2026', json('info-sd1030_hurricane_2026.json'));
  check('the 2026 Saildrone column count', sd.variables.length, 52);
  check('it is a trajectory', sd.cdmType, 'Trajectory');

  const temp = sd.variables.find((v) => v.name === 'sbe37_temperature_filtered');
  check('units survive', temp?.units, 'degrees_c');
  check('and the standard name', temp?.standardName, 'sea_water_temperature');
  ok('a measurement is not ancillary', temp?.ancillary === false);

  const id = sd.variables.find((v) => v.name === 'drone_id');
  ok('an identifier is ancillary', id?.ancillary === true);
  for (const name of ['time', 'latitude', 'longitude']) {
    ok(`${name} is a coordinate, not a variable`,
      sd.variables.find((v) => v.name === name)?.ancillary === true);
  }

  /* Engineering channels stay plottable: a pilot reading a mission wants
     them, and nobody else has to look at them. */
  ok('an engineering channel is kept',
    sd.variables.find((v) => v.name === 'wing_angle')?.ancillary === false);

  ok('the licence is kept, because the terms travel with the data',
    typeof sd.attributes.license === 'string' && sd.attributes.license.length > 0);
}

{
  /* The only era in the archive that publishes any QC column at all. */
  const old = parseInfo('sd1005_2017', json('info-sd1005_2017.json'));
  const qc = old.variables.filter((v) => /_QC$|_DM$/.test(v.name));
  ok('the 2017 era has QC and data-mode columns', qc.length >= 8, `${qc.length} of them`);
  ok('and every one is ancillary', qc.every((v) => v.ancillary));
}

{
  const oshen = parseInfo('oshenPD11_hurricane_2026', json('info-oshenPD11_hurricane_2026.json'));
  check('an Oshen carries eleven columns', oshen.variables.length, 11);
  /* Declared `units = 1` and published as percent — values of 82.0. Read at
     face value it is a humidity of 8,200%. The client reports what the
     server said; usv-vars is what overrides it. */
  check('relative humidity is declared dimensionless, as published',
    oshen.variables.find((v) => v.name === 'relative_humidity_mean')?.units, '1');
  check('and wind is in knots',
    oshen.variables.find((v) => v.name === 'wind_speed_mean_motion_corrected')?.units, 'knot');
}

{
  const chance = parseInfo('chanceMC29_NEFSC_nantucket_2026_nrt',
    json('info-chanceMC29_NEFSC_nantucket_2026_nrt.json'));
  ok('a Chance record is wide', chance.variables.length > 90, `${chance.variables.length}`);
  /* Chance publishes no units at all on several columns. */
  const baro = chance.variables.find((v) => v.name === 'BARO_PRES_FILTERED_MEAN');
  ok('pressure has no units published', !baro?.units, JSON.stringify(baro?.units));
  check('but it does say what it is', baro?.standardName, 'air_pressure');
}

{
  const files = parseInfo('chanceMC29_NEFSC_nantucket_2026_ctd',
    json('info-chanceMC29_NEFSC_nantucket_2026_ctd.json'));
  check('a file listing declares itself', files.cdmType, 'Other');
  ok('and has no plottable column at all',
    files.variables.every((v) => v.ancillary), files.variables.map((v) => v.name).join(', '));
}

/* ------------------------------------------------------------------------ */
section('parsing rows');

{
  const names = ['time', 'latitude', 'longitude', 'sbe37_temperature_filtered',
    'sbe37_practical_salinity_filtered', 'wind_speed_world_filtered',
    'baro_pressure_filtered'];
  const parsed = parseJsonlCsv(fixture('rows-sd1030.jsonl'),
    { names, timeColumns: new Set(['time']) });
  check('every row is read', parsed.rows, 121);
  check('and every column is that long', parsed.columns.get('latitude').length, 121);

  const t = parsed.columns.get('time');
  check('the first stamp', t[0], parseIsoTime('2026-08-14T00:00:00.000Z'));
  ok('time is ascending', t.every((v, i) => i === 0 || v >= t[i - 1]));

  /* The SBE37 reports every 5 minutes into a 1-minute record. A `null` on
     the wire has to arrive as NaN and not as zero: zero would draw a line
     through 0 °C where the sensor simply had not reported. */
  const temp = parsed.columns.get('sbe37_temperature_filtered');
  const missing = [...temp].filter(Number.isNaN).length;
  ok('the 5-minute interleave arrives as NaN, not zero',
    missing > 90 && missing < 100, `${missing} of 121 rows missing`);
  ok('no zero was invented', ![...temp].some((v) => v === 0));
  check('and the values that are there are real', Math.round(temp[0] * 100) / 100, 29.56);

  const wind = parsed.columns.get('wind_speed_world_filtered');
  ok('the 1-minute channel is dense', [...wind].filter(Number.isNaN).length === 0);
}

{
  const names = ['time', 'latitude', 'longitude', 'air_pressure_mean', 'sst_mean',
    'wind_speed_mean_motion_corrected', 'relative_humidity_mean'];
  const parsed = parseJsonlCsv(fixture('rows-oshenPD22.jsonl'),
    { names, timeColumns: new Set(['time']) });
  ok('an Oshen day parses', parsed.rows > 200, `${parsed.rows} rows`);
  /* Oshen humidity is published as percent under `units = 1`. */
  const rh = parsed.columns.get('relative_humidity_mean');
  const finite = [...rh].filter(Number.isFinite);
  ok('and its humidity really is percent, not a fraction',
    Math.max(...finite) > 20, `max ${Math.max(...finite)}`);
}

ok('a truncated final line is dropped rather than guessed at',
  parseJsonlCsv('[1,2]\n[3,', { names: ['a', 'b'] }).rows === 1);
ok('a blank line is not a row', parseJsonlCsv('[1,2]\n\n[3,4]\n', { names: ['a', 'b'] }).rows === 2);

/* ------------------------------------------------------------------------ */
section('cadence is the median, not the mean');

{
  /* An Oshen's cadence varies from 2 to 5 minutes with the link, and every
     record has gaps of hours. The mean would be dragged by the gaps and the
     minimum by a duplicate stamp; only the median says what the vehicle
     normally does. */
  const t = new Float64Array(600);
  for (let i = 0; i < 600; i++) t[i] = i * 300;
  check('a clean 5-minute record', medianCadence(t), 300);

  const gappy = Float64Array.from(t);
  for (let i = 400; i < 600; i++) gappy[i] += 40000;   // one long outage
  check('a long gap does not move it', medianCadence(gappy), 300);

  ok('too few rows is NaN, not a guess', Number.isNaN(medianCadence(new Float64Array([1]))));
}

/* ------------------------------------------------------------------------ */
section('activity');

{
  const now = 1787000000;
  const d = (end) => ({ end });
  ok('a vehicle reporting an hour ago is active', isActive(d(now - 3600), now));
  /* Every active mission in this archive reports at least every five
     minutes, so six hours of silence is a fact worth showing. */
  ok('one silent for eight hours is not', !isActive(d(now - 8 * 3600), now));
  ok('a record with no end time is not active', !isActive(d(NaN), now));
}

throws('an unreadable fixture fails loudly', () => json('does-not-exist.json'));

/* ------------------------------------------------------------------------ */
section('the request everything else waits on is retried');

/*
 * The catalog request had no retry and no timeout — a bare `fetch` — and it
 * is the *first* call of every build. One dropped connection from PMEL
 * (`UND_ERR_SOCKET: other side closed`, `bytesRead: 0`) failed a deploy that
 * had nothing else wrong with it, and the whole site published nothing.
 */
{
  const ok200 = () => new Response('{}', { status: 200 });

  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    return ok200();
  };
  const r = await fetchWithRetry('https://example.invalid/x', { fetchImpl: flaky, retries: 2, timeoutMs: 50 });
  check('a dropped connection is retried rather than fatal', r.status, 200);
  check('and it took the attempts it needed', calls, 3);

  let tries = 0;
  const dead = async () => { tries++; throw new Error('nope'); };
  /* `throws` is synchronous and cannot see a rejected promise — awaiting the
     rejection here is the difference between testing this and testing
     nothing. */
  let threw = false;
  try {
    await fetchWithRetry('https://example.invalid/x', { fetchImpl: dead, retries: 1, timeoutMs: 50 });
  } catch { threw = true; }
  ok('an error that never clears still throws in the end', threw);
  check('  after the attempts it was given', tries, 2);

  /* A 404 is an answer. Asking three times gets the same one. */
  let asked = 0;
  const missing = async () => { asked++; return new Response('', { status: 404 }); };
  const gone = await fetchWithRetry('https://example.invalid/x', { fetchImpl: missing, retries: 2, timeoutMs: 50 });
  check('a 404 comes straight back', gone.status, 404);
  check('  asked once, not three times', asked, 1);

  /* A 200 is not retried either. */
  let once = 0;
  const good = async () => { once++; return ok200(); };
  await fetchWithRetry('https://example.invalid/x', { fetchImpl: good, retries: 2, timeoutMs: 50 });
  check('and a success is asked for exactly once', once, 1);
}

done();
