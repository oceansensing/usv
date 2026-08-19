#!/usr/bin/env node
/**
 * The build's own plumbing: the cache that decides what is fetched again.
 *
 *   npm run test:build
 *
 * One thing is tested here and it is worth a suite. **The cache holds derived
 * files, not upstream responses** — quality findings, canonical names, derived
 * quantities, the rounding, the sentences the page prints. Keyed on the
 * record's last report time alone, a correction to any of that reaches only
 * the vehicles still reporting, because an archived record's `maxTime` never
 * moves again.
 *
 * That is not hypothetical. `coverageNote` was corrected on 46 records, the
 * build ran green, the site deployed, and all 46 came back with the old
 * sentence — none of them had reported since 2024. The format version in the
 * key is what makes a fix reach the archive, and these are the checks that it
 * still does.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, done, ok, section } from './lib/check.mjs';
import { Cache, groupByChunk, INFO_FORMAT, infoCache } from './lib/bake.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-cache-'));

/* ------------------------------------------------------------------------ */
section('a cache must declare what version of a thing it stores');

/* Not a default, deliberately: a caller that has not thought about the
   version is a caller whose next fix will not reach its data. */
for (const bad of [undefined, null, 0, -1, 1.5, '1']) {
  let threw = false;
  try { new Cache(tmp, bad); } catch { threw = true; }
  ok(`${JSON.stringify(bad) ?? 'undefined'} is refused`, threw);
}
ok('and an integer is accepted', Boolean(new Cache(tmp, 1)));

/* ------------------------------------------------------------------------ */
section('an entry belongs to one version and one report time');

{
  const v1 = new Cache(tmp, 1);
  const v2 = new Cache(tmp, 2);
  const stamp = 1_626_307_200;

  v1.write('sd1065_tpos_2021', stamp, { qcNote: 'the old sentence' });
  check('what was written comes back',
    v1.read('sd1065_tpos_2021', stamp)?.qcNote, 'the old sentence');

  /* The case that shipped: the record has not reported since — same id, same
     stamp — and the only thing that changed is the code. */
  check('a later format does not read the earlier one',
    v2.read('sd1065_tpos_2021', stamp), undefined);

  v2.write('sd1065_tpos_2021', stamp, { qcNote: 'the corrected sentence' });
  check('and each keeps its own',
    v1.read('sd1065_tpos_2021', stamp)?.qcNote, 'the old sentence');
  check('  side by side',
    v2.read('sd1065_tpos_2021', stamp)?.qcNote, 'the corrected sentence');

  /* The half of the key that was always right: an active mission invalidates
     itself as it reports. */
  check('a moved report time misses', v2.read('sd1065_tpos_2021', stamp + 60), undefined);

  ok('the version is visible in the name, so a stale entry can be found',
    path.basename(v2.path('x', stamp)).includes('v2'),
    path.basename(v2.path('x', stamp)));
  ok('and an id with awkward characters still lands in the cache directory',
    path.dirname(v2.path('a b', stamp)) === tmp);
}

/* ------------------------------------------------------------------------ */
section('pruning clears the versions nothing asks for any more');

{
  const v3 = new Cache(tmp, 3);
  const stamp = 1_626_307_200;
  v3.write('sd1065_tpos_2021', stamp, { keep: true });
  const dropped = v3.prune([v3.path('sd1065_tpos_2021', stamp)]);
  ok('the superseded entries go', dropped >= 2, `${dropped} dropped`);
  check('and the one still in use stays',
    v3.read('sd1065_tpos_2021', stamp)?.keep, true);
}

/* ------------------------------------------------------------------------ */
section('one path, and no script spells it out for itself');

/*
 * The info cache is written by `data:catalog` and read by the other two
 * builds. It used to be three separate constructions of the same filename —
 * a `Cache` in the writer and a hand-rolled `infoCachePath` in each reader —
 * so putting a version in the key broke both readers at once and the build
 * stopped dead at 0 of 153. It is one function now, and this is what keeps it
 * one.
 */
{
  const scripts = ['build-catalog', 'build-series', 'build-detail']
    .map((n) => [n, fs.readFileSync(new URL(`./${n}.mjs`, import.meta.url), 'utf8')]);

  for (const [name, src] of scripts) {
    ok(`${name} goes through the shared cache`, src.includes('infoCache()'));
    ok(`  and does not build the path itself`, !/\.cache\/info/.test(src),
      /\.cache\/info/.test(src) ? 'still has a literal path' : 'no literal path');
    ok(`  nor the stamp`, !/Number\.isFinite\(d\.end\) \? Math\.round\(d\.end\)/.test(src));
  }

  /* Writer and readers must agree, which they can only do by construction. */
  const a = infoCache().path('sd1065_tpos_2021', Cache.stamp({ end: 1_626_307_200 }));
  const b = infoCache().path('sd1065_tpos_2021', Cache.stamp({ end: 1_626_307_200.4 }));
  check('the same record resolves to the same entry', a, b);
  ok('and the info format is declared', Number.isInteger(INFO_FORMAT) && INFO_FORMAT >= 1,
    `v${INFO_FORMAT}`);
  ok('a record with no end still keys somewhere',
    typeof infoCache().path('x', Cache.stamp({ end: NaN })) === 'string');
}

/* ------------------------------------------------------------------------ */
section('a row with no timestamp belongs to no week');

/*
 * `oshenPC1_hurricane_2025` is 31,983 rows of which **5,493 carry no time at
 * all** — which is also why ERDDAP publishes an empty `maxTime` for it. Such a
 * row cannot be placed in a chunk, and dropping it is the only correct thing
 * to do; the bug was reporting the count that went *in*. The shard held
 * 26,490 samples and its index promised 31,983, and the vehicle page prints
 * that number as an offer.
 */
{
  const WEEK = 7 * 86400;
  const t0 = 2914 * WEEK;

  const clean = Float64Array.from([t0, t0 + 60, t0 + 120]);
  const a = groupByChunk(clean, WEEK);
  check('every timed row is placed', a.placed, 3);
  check('and none is dropped', a.dropped, 0);
  check('all in the one week', a.groups.get(2914).length, 3);

  const holed = Float64Array.from([t0, NaN, t0 + 120, NaN, NaN]);
  const b = groupByChunk(holed, WEEK);
  check('a row with no time is not placed', b.placed, 2);
  check('and is counted as dropped', b.dropped, 3);
  ok('placed and dropped account for every row', b.placed + b.dropped === holed.length);

  /* The count the index must report is what came out, never what went in. */
  const held = [...b.groups.values()].reduce((n, g) => n + g.length, 0);
  check('the rows the chunks hold equal the placed count', held, b.placed);
  ok('which is not the row count that went in', b.placed !== holed.length,
    `${b.placed} placed of ${holed.length}`);

  /* Out-of-order rows are grouped, not sliced: Oshen records and the 2020
     Arctic Saildrones both step backwards between consecutive rows. */
  const backwards = Float64Array.from([t0 + WEEK, t0, t0 + WEEK + 60]);
  const c = groupByChunk(backwards, WEEK);
  check('a backwards step keeps both weeks', c.groups.size, 2);
  check('  the earlier week has its row', c.groups.get(2914).length, 1);
  check('  and the later one keeps both of its own', c.groups.get(2915).length, 2);
  check('nothing is lost to the disorder', c.placed, 3);

  check('nothing in is nothing out', groupByChunk(Float64Array.from([]), WEEK).placed, 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
