#!/usr/bin/env node
/**
 * The documentation, checked against the repository it describes.
 *
 *   npm run check:docs
 *
 * Not a spell-check and not a word count. It asserts the few things that go
 * stale silently: a package added without a note saying what it is for, a
 * test suite `verify` runs but no table lists, a page that exists and is
 * documented nowhere, and a live URL the build does not actually serve. Each
 * of those is invisible until somebody needs the document and finds a hole
 * in it.
 */

import fs from 'node:fs';
import { check, done, ok, section } from './lib/check.mjs';

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

section('the documents exist');

for (const doc of ['README.md', 'CLAUDE.md', 'PLAN.md', 'NEXT.md', 'LICENSE']) {
  ok(`${doc} is present`, read(doc).length > 200, `${read(doc).length} bytes`);
}

section('every package says what it is for');

{
  /* A package with no note is a package the next person has to read in full
     to find out whether it is the one they want. */
  const packages = fs.readdirSync('packages').filter(
    (name) => fs.existsSync(`packages/${name}/package.json`),
  );
  ok('there are packages to check', packages.length >= 5, packages.join(', '));

  for (const name of packages) {
    const notes = read(`packages/${name}/CLAUDE.md`) + read(`packages/${name}/README.md`);
    ok(`packages/${name} is documented`, notes.length > 500,
      `${notes.length} bytes of notes`);
  }

  /* The root document points at the package ones rather than repeating them,
     so it has to actually name them. */
  const root = read('CLAUDE.md') + read('README.md');
  for (const name of packages) {
    ok(`the root docs mention packages/${name}`, root.includes(`packages/${name}`));
  }
}

section('every suite `verify` runs is written down');

{
  const pkg = JSON.parse(read('package.json'));
  const suites = Object.keys(pkg.scripts).filter((s) => s.startsWith('test:'));
  const claude = read('CLAUDE.md');
  ok('there are suites to check', suites.length >= 7, suites.join(', '));
  for (const suite of suites) {
    ok(`${suite} appears in CLAUDE.md`, claude.includes(suite));
  }

  /* And `verify` actually runs all of them — a suite that exists but is not
     chained is a suite nobody runs. */
  const verify = pkg.scripts.verify ?? '';
  const missing = suites.filter((s) => !verify.includes(s));
  ok('and verify runs every one', missing.length === 0,
    missing.join(', ') || 'all chained');
}

section('every page is described');

{
  const pages = fs.readdirSync('src/pages')
    .filter((f) => f.endsWith('.astro'))
    .map((f) => f.replace(/\.astro$/, ''));
  const docs = read('README.md') + read('CLAUDE.md') + read('PLAN.md') + read('NEXT.md');
  for (const page of pages) {
    if (page === '404') continue;
    const route = page === 'index' ? '/' : `/${page}/`;
    ok(`${route} is described`, docs.includes(route), route);
  }
}

section('the data build is documented');

{
  /* The two scripts that make the site have data at all. If either is
     renamed and the docs are not, `npm run data` is a command in a README
     that does not exist. */
  const pkg = JSON.parse(read('package.json'));
  const docs = read('README.md') + read('CLAUDE.md') + read('PLAN.md');
  for (const script of ['data:catalog', 'data:series']) {
    ok(`${script} is a script`, Boolean(pkg.scripts[script]));
  }
  ok('`npm run data` is in the README', read('README.md').includes('npm run data'));
  ok('and the build scripts are named somewhere',
    docs.includes('build-series.mjs') && docs.includes('build-catalog.mjs'));
}

section('the facts the site rests on are written down, with their numbers');

{
  /* Every one of these is a *measured* number that a later edit could
     invalidate without noticing. They are in the docs so a reader can check
     them; they are checked here so they cannot quietly disappear. */
  const docs = read('CLAUDE.md') + read('PLAN.md') + read('README.md') + read('NEXT.md')
    + read('packages/erddap-pmel/CLAUDE.md') + read('packages/usv-vars/CLAUDE.md')
    + read('packages/usv-qc/CLAUDE.md');

  const facts = [
    ['PMEL sends no CORS header', /Access-Control-Allow-Origin/],
    ['the archive publishes no QC flags', /no QARTOD|no QC column/i],
    ['the 5-minute decimation alignment', /80\.2\s*%/],
    ['the JSON-beats-binary measurement', /315,?473|315 KB/],
    ['the U10 adjustment', /\+?31\s*%/],
    ['the sea-pressure trap', /4\.28|4\.3 kg/],
    ['the number of plottable records', /153/],
    ['the full-rate archive size', /794 MB/],
    ['the Pages published-site limit', /1 GB/],
    ['the shard naming scheme', /usv-data-/],
  ];
  for (const [what, pattern] of facts) {
    ok(`${what} is documented`, pattern.test(docs));
  }
}

section('the shard scheme is written down where it is needed');

{
  /* The season repositories are a published contract — their URLs are what
     the site fetches — so the arrangement has to be findable from the
     documents rather than only from `shard.ts`. */
  const docs = read('README.md') + read('CLAUDE.md') + read('PLAN.md') + read('NEXT.md');
  ok('the same-origin argument is recorded', /same origin/i.test(docs));
  ok('and why a season rather than some other split', /immutable/i.test(docs));
  ok('and that a closed season is built once', /built once/i.test(docs));
  ok('the live shard is named', docs.includes('usv-data-2026'));
  ok('and the detail build command', /data:detail/.test(docs));
}

section('the live URL is stated the same way everywhere');

{
  const live = 'https://oceansensing.org/usv/';
  for (const doc of ['README.md', 'PLAN.md', 'CLAUDE.md']) {
    ok(`${doc} names the live site`, read(doc).includes(live));
  }
  /* The base path the build uses and the URL the documents promise have to
     agree, or the documents send people to a 404. */
  const config = read('astro.config.mjs');
  const base = /base:\s*'([^']+)'/.exec(config)?.[1];
  check('and the build serves it there', `https://oceansensing.org${base}/`, live);
}

done();
