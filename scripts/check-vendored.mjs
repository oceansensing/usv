#!/usr/bin/env node
/**
 * Whether the vendored packages have drifted from their source.
 *
 *   npm run check:vendored
 *
 * `packages/plot` and `packages/teos10` are **copies** of the packages in the
 * sibling `gliders` repository, and `scripts/data/saar.bin.gz` is a copy of
 * the salinity atlas it serves. Copying was the deliberate choice over a
 * submodule or an npm release: both packages are zero-dependency TypeScript
 * written to be lifted whole, this repository stays self-contained, and CI
 * needs nothing but a checkout.
 *
 * The cost of a copy is drift, and the answer to drift is a check rather than
 * a promise. **This one reports; it does not fail the build**, because the
 * source repository is not present in CI and its absence is not an error.
 * Run it by hand before releasing, or after pulling the other repository.
 *
 * It has already earned its keep once: `src/styles/tokens.css` had drifted
 * and was missing the three map-marker colours entirely, so the exported
 * PNG's markers and the page's disagreed.
 *
 * `src/lib/figure.ts`, `track.ts`, `track-legend.ts` and `map-export.ts` are
 * **adapted** copies rather than vendored ones — they are site code, and the
 * two sites' versions are each their own. They are compared here as a
 * courtesy, and a difference in them is expected rather than alarming.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = process.env.GLIDERS_REPO
  ?? path.resolve(process.env.HOME ?? '', 'GitHub/gliders');

/** Copied whole. A difference here is drift and should be reconciled. */
const VENDORED = [
  'packages/plot/plot.ts',
  'packages/plot/colormaps.ts',
  'packages/plot/png.ts',
  'packages/plot/robust.ts',
  'packages/plot/index.ts',
  'packages/plot/CLAUDE.md',
  'packages/teos10/atlas.ts',
  'packages/teos10/constants.ts',
  'packages/teos10/contour.ts',
  'packages/teos10/depth.ts',
  'packages/teos10/gibbs.ts',
  'packages/teos10/gibbs-ice.ts',
  'packages/teos10/index.ts',
  'packages/teos10/properties.ts',
  'packages/teos10/salinity.ts',
  'packages/teos10/temperature.ts',
  'src/styles/tokens.css',
  'src/components/PlotFigure.astro',
  'src/components/TrackFigure.astro',
  'src/components/ThemeToggle.astro',
  'src/components/Header.astro',
  'src/layouts/BaseLayout.astro',
  'scripts/lib/check.mjs',
];

/** Adapted on purpose. A difference is expected; the check is here so the
    *size* of the difference stays visible. */
const ADAPTED = [
  ['src/lib/figure.ts', 'src/lib/figure.ts'],
  ['src/lib/track.ts', 'src/lib/track.ts'],
  ['src/lib/track-legend.ts', 'src/lib/track-legend.ts'],
  ['src/lib/map-export.ts', 'src/lib/map-export.ts'],
  ['src/lib/url.ts', 'src/lib/url.ts'],
  ['src/styles/global.css', 'src/styles/global.css'],
  ['src/components/Footer.astro', 'src/components/Footer.astro'],
  ['scripts/test-plot.mjs', 'scripts/test-plot.mjs'],
  ['scripts/test-contrast.mjs', 'scripts/test-contrast.mjs'],
];

/** Binary, so only the digest is meaningful. */
const BINARY = [['scripts/data/saar.bin.gz', 'public/teos10/saar.bin.gz']];

if (!fs.existsSync(SOURCE)) {
  console.log(`The source repository is not here (${SOURCE}).`);
  console.log('Set GLIDERS_REPO to compare, or run this where it is checked out.');
  process.exit(0);
}

const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').length;

let drifted = 0;
let missing = 0;

console.log(`comparing against ${SOURCE}\n`);
console.log('-- copied whole --');
for (const rel of VENDORED) {
  const mine = rel;
  const theirs = path.join(SOURCE, rel);
  if (!fs.existsSync(mine)) { console.log(`  ?  ${rel} — not here`); missing++; continue; }
  if (!fs.existsSync(theirs)) { console.log(`  ?  ${rel} — not in the source`); missing++; continue; }
  if (digest(mine) === digest(theirs)) {
    console.log(`  ok ${rel}`);
  } else {
    console.log(`  !! ${rel} — DRIFTED (${lines(mine)} lines here, ${lines(theirs)} there)`);
    drifted++;
  }
}

console.log('\n-- adapted on purpose --');
for (const [mine, rel] of ADAPTED) {
  const theirs = path.join(SOURCE, rel);
  if (!fs.existsSync(mine) || !fs.existsSync(theirs)) {
    console.log(`  ?  ${mine} — one side is absent`);
    continue;
  }
  const same = digest(mine) === digest(theirs);
  console.log(`  ${same ? 'identical' : 'adapted  '} ${mine}`
    + (same ? '' : ` (${lines(mine)} lines here, ${lines(theirs)} there)`));
}

console.log('\n-- binary --');
for (const [mine, rel] of BINARY) {
  const theirs = path.join(SOURCE, rel);
  if (!fs.existsSync(mine) || !fs.existsSync(theirs)) {
    console.log(`  ?  ${mine} — one side is absent`);
    continue;
  }
  const same = digest(mine) === digest(theirs);
  console.log(`  ${same ? 'ok' : '!!'} ${mine}${same ? '' : ' — DRIFTED'}`);
  if (!same) drifted++;
}

console.log('');
if (drifted) {
  console.log(`${drifted} vendored file${drifted === 1 ? ' has' : 's have'} drifted.`);
  console.log('Reconcile deliberately — the copy is the one that ships here.');
} else if (missing) {
  console.log(`${missing} file${missing === 1 ? '' : 's'} could not be compared.`);
} else {
  console.log('No drift.');
}
/* Reports, never fails: the source repository is not present in CI. */
