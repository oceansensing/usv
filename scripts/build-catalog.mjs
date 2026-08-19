#!/usr/bin/env node
/**
 * The catalog: every USV record PMEL publishes, with enough about each one
 * for the fleet page to draw and search it without touching the network.
 *
 *   npm run data:catalog
 *
 * Runs under Node because it must: PMEL sends no `Access-Control-Allow-Origin`
 * header, so a browser cannot read it at all. Writes
 * `public/data/catalog.json`, which is gitignored and rebuilt by CI.
 *
 * This is the quick half of the data build — one `allDatasets` request plus
 * one `info` request per dataset, all small. `build-series.mjs` is the slow
 * half and depends on the file this writes.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fetchInfo, listDatasets, PMEL, variantOf,
} from '../packages/erddap-pmel/index.ts';
import { resolveDataset } from '../packages/usv-vars/index.ts';
import { unknownUnits } from '../packages/usv-qc/index.ts';
import { Cache, human, pool, writeJson } from './lib/bake.mjs';

const OUT = fileURLToPath(new URL('../public/data/catalog.json', import.meta.url));
const CACHE = fileURLToPath(new URL('../.cache/info', import.meta.url));

const args = new Set(process.argv.slice(2));
const refresh = args.has('--refresh');

const started = Date.now();
console.log(`catalog ← ${PMEL}`);

const datasets = await listDatasets(PMEL);
console.log(`  ${datasets.length} USV datasets`);

/**
 * What a cached entry of this build contains.
 *
 * Bump when `fetchInfo`/`parseInfo` change what they return — the entries
 * here are the *parsed* dataset info, not the bytes PMEL sent, so a change to
 * the parse leaves every archived record on the old shape. See `Cache`.
 */
const CACHE_FORMAT = 1;

const cache = new Cache(CACHE, CACHE_FORMAT);
const kept = [];

/* An `info` document changes only when the dataset is re-published, so it is
   keyed on the record's last report time like everything else — see
   `Cache`. `--refresh` bypasses it for the case where PMEL corrected the
   metadata without the data moving, which the key cannot see. */
const entries = await pool(datasets, 3, async (d) => {
  const stamp = Number.isFinite(d.end) ? Math.round(d.end) : 'none';
  let doc = refresh ? undefined : cache.read(d.id, stamp);
  if (!doc) {
    try {
      doc = await fetchInfo(d.id, PMEL);
      cache.write(d.id, stamp, doc);
    } catch (error) {
      console.log(`  ! ${d.id}: ${error.message}`);
      return undefined;
    }
  }
  kept.push(cache.path(d.id, stamp));
  return { summary: d, info: doc };
});

const found = entries.filter(Boolean);

/* Everything the fleet page needs, and nothing it does not: the summary, the
   quantities the record carries so the search can filter on them, and the
   attribution the licence requires. The *series* — every number — is a
   separate file per dataset, loaded only when a reader opens one. That split
   is what makes the fleet page open in one small request rather than 200 MB. */
const out = [];
const unknownUnitStrings = new Set();

for (const { summary, info } of found) {
  const resolved = resolveDataset(info.variables);
  /* Only the records the site actually draws. A file listing's columns are
     `url`, `name` and `size`, whose units are `bytes` and `m3`, and an
     echosounder listing carries a `dB` string per frequency band — thirty
     entries of noise that would bury the one finding that matters, which is
     the `¡C` on the two LWR datasets. */
  if (summary.kind !== 'files') {
    for (const u of unknownUnits(info.variables)) unknownUnitStrings.add(u);
  }

  out.push({
    ...summary,
    variant: variantOf(summary.id),
    summary: info.summary.slice(0, 600),
    cdmType: info.cdmType,
    /* Sorted, so a rebuild that changes nothing produces a byte-identical
       file and the diff between builds is only what actually moved. */
    quantities: [...resolved.primary.keys()].sort(),
    variables: info.variables.length,
    attributes: info.attributes,
    /* `allDatasets` gives a bounding box; the `info` document sometimes has
       a tighter one. Neither is the track, which the series file carries. */
    bounds: info.bounds,
  });
}

out.sort((a, b) => (b.end || 0) - (a.end || 0) || a.id.localeCompare(b.id));

/* Campaigns are derived here rather than in the page, so the fleet and the
   campaign pages cannot disagree about which vehicles flew together. */
const campaigns = new Map();
for (const d of out) {
  if (d.kind === 'files') continue;
  const c = campaigns.get(d.campaign) ?? {
    slug: d.campaign,
    label: d.campaignLabel,
    vendors: new Set(),
    datasets: [],
    start: Infinity,
    end: -Infinity,
  };
  c.vendors.add(d.vendor);
  c.datasets.push(d.id);
  if (Number.isFinite(d.start)) c.start = Math.min(c.start, d.start);
  if (Number.isFinite(d.end)) c.end = Math.max(c.end, d.end);
  campaigns.set(d.campaign, c);
}

const campaignList = [...campaigns.values()]
  .map((c) => ({
    slug: c.slug,
    label: c.label,
    vendors: [...c.vendors].sort(),
    datasets: c.datasets.sort(),
    start: Number.isFinite(c.start) ? c.start : null,
    end: Number.isFinite(c.end) ? c.end : null,
  }))
  .sort((a, b) => (b.end ?? 0) - (a.end ?? 0));

const doc = {
  fetched: Math.floor(started / 1000),
  source: PMEL,
  datasets: out,
  campaigns: campaignList,
  /* Reported so a unit that turns up in a future season is noticed rather
     than passed through as an unrecognised string on a plot. */
  unknownUnits: [...unknownUnitStrings].sort(),
};

const bytes = writeJson(OUT, doc);
const dropped = cache.prune(kept);

const plottable = out.filter((d) => d.kind !== 'files');
console.log(`  ${plottable.length} plottable, ${out.length - plottable.length} file listings`);
console.log(`  ${campaignList.length} campaigns`);
if (doc.unknownUnits.length) {
  console.log(`  unrecognised units: ${doc.unknownUnits.join(', ')}`);
}
console.log(`  ${human(bytes)} → public/data/catalog.json`
  + `${dropped ? `, ${dropped} stale cache entries dropped` : ''}`);
console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s`);

/* Same rule as `build-series.mjs`: a metadata document the server will not
   serve costs one record, not the deploy. Losing many of them means
   something systemic and the published site should stay up instead. */
const lost = datasets.length - found.length;
if (lost) {
  console.log(`\n  ${lost} dataset${lost === 1 ? '' : 's'} could not be read.`);
  if (lost / datasets.length > 0.05) {
    console.log('  That is past what this tolerates. Not deploying this.');
    process.exitCode = 1;
  }
}
