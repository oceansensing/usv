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
import { Cache } from './lib/bake.mjs';

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

fs.rmSync(tmp, { recursive: true, force: true });
done();
