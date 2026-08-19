#!/usr/bin/env node
/**
 * The built pages, read as files.
 *
 *   npm run test:pages
 *
 * Runs against `dist/`, so `npm run build` has to have happened — `verify`
 * chains them in that order. What it checks is the class of mistake that
 * compiles, type-checks, works in `astro dev`, and breaks only once the site
 * is served from a subdirectory or with the policy applied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { done, ok, section } from './lib/check.mjs';

const DIST = 'dist';
if (!fs.existsSync(DIST)) {
  console.log('dist/ is missing — run `npm run build` first.');
  process.exit(1);
}

const BASE = '/usv';

/** Every built HTML file. */
function pages(dir = DIST) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pages(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const HTML = pages();
const docs = HTML.map((file) => ({
  file,
  text: fs.readFileSync(file, 'utf8'),
  dom: new JSDOM(fs.readFileSync(file, 'utf8')),
}));

/**
 * Every stylesheet the build emitted, concatenated.
 *
 * **Both the linked files and the inlined `<style>` blocks.** Astro inlines a
 * small stylesheet into the page and emits a larger one as a file, so a check
 * that reads only one of them passes or fails depending on a bundler's size
 * heuristic rather than on the CSS — which is how the sibling site had six
 * checks fail against rules that were perfectly correct.
 */
const ALL_CSS = [
  ...fs.readdirSync(path.join(DIST, '_astro'), { withFileTypes: true })
    .filter((e) => e.name.endsWith('.css'))
    .map((e) => fs.readFileSync(path.join(DIST, '_astro', e.name), 'utf8')),
  ...docs.flatMap(({ dom }) =>
    [...dom.window.document.querySelectorAll('style')].map((s) => s.textContent ?? '')),
].join('\n');

/* ------------------------------------------------------------------------ */
section('the pages that should exist do');

for (const route of ['index.html', 'vehicle/index.html', 'campaign/index.html',
  'qc/index.html', 'about/index.html']) {
  ok(`${route} was built`, fs.existsSync(path.join(DIST, route)));
}

/* ------------------------------------------------------------------------ */
section('the base path is applied to every internal URL');

/* The site is served from `/usv/` and Astro rewrites nothing — `base` is a
   value the code applies. A root-absolute internal href works perfectly in
   `astro dev` and 404s on Pages. */
for (const { file, dom } of docs) {
  const bad = [];
  const doc = dom.window.document;
  for (const el of doc.querySelectorAll('a[href], link[href], script[src], img[src]')) {
    const url = el.getAttribute('href') ?? el.getAttribute('src') ?? '';
    if (!url.startsWith('/')) continue;          // relative, hash, or absolute
    if (url.startsWith(`${BASE}/`) || url === BASE) continue;
    bad.push(`${el.tagName.toLowerCase()} ${url}`);
  }
  ok(`${file} writes no root-absolute internal URL`, bad.length === 0, bad.join(', '));
}

/* The one that is not a link and so fails silently: the series fetch. */
{
  const js = fs.readdirSync(path.join(DIST, '_astro'))
    .filter((n) => n.endsWith('.js'))
    .map((n) => fs.readFileSync(path.join(DIST, '_astro', n), 'utf8'))
    .join('\n');
  ok('the data paths go through withBase',
    js.includes('/data/catalog.json') && js.includes('/data/series'),
    'the paths are present to be prefixed at runtime');
  /* A literal `"/data/...` with no base in front of it would be a fetch to
     the domain root. The join happens at runtime, so what is checked is that
     nothing wrote the prefixed form by hand — which would double it. */
  ok('and none of them was written with the base already in it',
    !js.includes(`"${BASE}/data/`) && !js.includes(`'${BASE}/data/`),
    'no doubled base');
}

/* ------------------------------------------------------------------------ */
section('the content security policy survived the build');

for (const { file, dom } of docs) {
  const meta = dom.window.document.querySelector(
    'meta[http-equiv="content-security-policy" i]');
  if (!ok(`${file} carries a CSP`, Boolean(meta))) continue;
  const csp = meta.getAttribute('content') ?? '';

  /* **`connect-src 'self'` is the whole point of the baked build.** The
     sibling glider site has to allow `https:` because its ERDDAP client
     fetches from the reader's browser. This site cannot do that — PMEL sends
     no CORS header — so the policy is narrower, and a later edit that
     reintroduces a cross-origin fetch is stopped here rather than working in
     Node and failing in a browser. */
  ok(`  connect-src is 'self' and nothing more`,
    /connect-src 'self'(;|$)/.test(csp), csp.match(/connect-src[^;]*/)?.[0]);

  ok(`  script-src has no 'unsafe-inline'`,
    !/script-src[^;]*unsafe-inline/.test(csp), csp.match(/script-src[^;]*/)?.[0]);
  ok(`  object-src is 'none'`, /object-src 'none'/.test(csp));
  ok(`  base-uri is 'self'`, /base-uri 'self'/.test(csp));
  /* Basemap tiles, plus data:/blob: for the PNG export's round trip. */
  ok(`  img-src allows the basemap`, /img-src[^;]*https:/.test(csp));
  /* @fontsource inlines its woff2 subsets as data URIs; without this every
     page loads in the fallback face. */
  ok(`  font-src allows data:`, /font-src[^;]*data:/.test(csp));
}

/* ------------------------------------------------------------------------ */
section('the CSS rules jsdom cannot see');

/* **Two rules stand between an invisible hit line and a clickable one.**
   SVG's default `pointer-events: visiblePainted` makes an element a target
   only where it is painted, and a transparent stroke paints nothing — so the
   fat line under each track swallows every click. And the selector has to
   out-specify Leaflet's own `.leaflet-interactive { pointer-events: auto }`,
   which is imported after this stylesheet and wins at equal specificity;
   hence the element name in front of the class. */
ok('the track hit line is a pointer target',
  /path\.track-hit\s*\{[^}]*pointer-events:\s*stroke/.test(ALL_CSS)
  || /\.track-hit\s*\{[^}]*pointer-events:\s*stroke/.test(ALL_CSS),
  'path.track-hit { pointer-events: stroke }');
ok('and it out-specifies Leaflet',
  /path\.track-hit/.test(ALL_CSS), 'the selector carries the element name');

/* An SVG path fills by default, so without this the axis renders as a solid
   triangle across the plot. */
ok('stroked plot paths do not fill', /fill:\s*none/.test(ALL_CSS));

/* Leaflet's own stylesheet is what gives `.leaflet-container` its
   `overflow: hidden`. Without it the tile pane is not clipped and the tiles
   render over whatever is above them — seen on the sibling site as a map
   drawn across the page title. */
ok('Leaflet\'s stylesheet is in the bundle',
  /\.leaflet-container/.test(ALL_CSS) && /overflow:\s*hidden/.test(ALL_CSS));

/* **An author `display` beats `[hidden]`.** The UA rule
   `[hidden] { display: none }` is author-level and of the lowest
   specificity, so any `display` this site sets on the same element wins and
   the element shows whether the code hid it or not. It happened to the
   vehicle page's window banner, which appeared on every record with no
   window set. Every element given both needs the guard. */
{
  const displayed = [...ALL_CSS.matchAll(/\.([a-z-]+)\s*\{[^}]*display:\s*(flex|grid|block|inline-flex)/g)]
    .map((m) => m[1]);
  const guarded = new Set(
    [...ALL_CSS.matchAll(/\.([a-z-]+)\[hidden\]/g)].map((m) => m[1]),
  );
  /* Only the classes the code actually toggles. A class with a `display`
     that nothing ever hides needs no guard, and demanding one would be
     noise. */
  const toggled = ['window'];
  for (const name of toggled) {
    ok(`.${name} survives being hidden`,
      !displayed.includes(name) || guarded.has(name),
      guarded.has(name) ? 'guarded' : 'has a display and no [hidden] rule');
  }
}

/* The map markers are the one set of colours judged against Esri's tiles
   rather than against the page, so they must not flip with the theme. */
ok('the map marker tokens ship', /--map-here:/.test(ALL_CSS)
  && /--map-past:/.test(ALL_CSS) && /--map-ring:/.test(ALL_CSS));

/* ------------------------------------------------------------------------ */
section('the page says what it is');

for (const { file, dom } of docs) {
  const doc = dom.window.document;
  ok(`${file} has a title`, (doc.title ?? '').length > 3, doc.title);
  ok(`  and a description`,
    (doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').length > 20);
  ok(`  and a canonical URL on oceansensing.org`,
    (doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '')
      .startsWith('https://oceansensing.org/usv'));
  ok(`  and one h1`, doc.querySelectorAll('h1').length === 1,
    `${doc.querySelectorAll('h1').length}`);
  ok(`  and a skip link`, Boolean(doc.querySelector('.skip-link')));
  ok(`  and a main landmark`, Boolean(doc.querySelector('main#main')));
  ok(`  and declares its language`, doc.documentElement.lang === 'en');
}

/* ------------------------------------------------------------------------ */
section('what the pages promise about the data');

/* Every page that shows an observation has to be able to say where it came
   from and when. These are the sentences the site's honesty rests on, and a
   redesign that drops them should fail. */
{
  const index = docs.find((d) => d.file === path.join(DIST, 'index.html'));
  ok('the fleet page names PMEL', /data\.pmel\.noaa\.gov/.test(index.text));
  ok('and says the site is not live',
    /not live|fetched when the site was built|cannot read it/i.test(index.text));

  /* **A snapshot cannot say "reporting now".** The data is rebuilt every six
     hours, so a perfectly healthy vehicle is up to six hours stale by the end
     of a cycle; asked against the wall clock the live count falls to zero
     before every rebuild. Measured 1.4 h after one build, it had already
     dropped from 21 to 2 with nothing at sea having changed. */
  ok('the fleet page does not claim to know what is reporting now',
    !/reporting now/i.test(index.text), 'says "reporting when fetched"');
  ok('and says when it looked instead', /when fetched/i.test(index.text));

  const about = docs.find((d) => d.file === path.join(DIST, 'about', 'index.html'));
  ok('the about page explains the CORS decision',
    /Access-Control-Allow-Origin/.test(about.text));
  ok('and states the U10 adjustment',
    /31\s*%/.test(about.text) && /10\s*m/.test(about.text));
  ok('and states the sea-pressure constant',
    /0\s*dbar/.test(about.text));

  const qc = docs.find((d) => d.file === path.join(DIST, 'qc', 'index.html'));
  ok('the quality page says the archive publishes no flags',
    /no quality flags/i.test(qc.text));
  ok('and that a finding never alters the data',
    /never removes or alters|never alters it/i.test(qc.text));
  /* Each check has to say what it is *not*. That framing is what stops the
     digest reading as an accusation about somebody else's instrument. */
  /* Matched with an attribute wildcard: Astro stamps its scoping attribute
     onto every element it renders, so a literal `<strong>` never appears in
     the built HTML. */
  const nots = (qc.text.match(/<strong[^>]*>Not:<\/strong>/g) ?? []).length;
  ok('and every check says what it is not', nots >= 9, `${nots} of 9`);
}

/* ------------------------------------------------------------------------ */
section('nothing was left switched on for development');

{
  const js = fs.readdirSync(path.join(DIST, '_astro'))
    .filter((n) => n.endsWith('.js'))
    .map((n) => fs.readFileSync(path.join(DIST, '_astro', n), 'utf8'))
    .join('\n');
  /* The map handle in `fleet.ts` is behind `import.meta.env.DEV`, which Vite
     replaces with `false` and then tree-shakes. If it reaches the bundle the
     guard has stopped working. */
  ok('the dev-only map handle is not in the bundle', !js.includes('__fleetMap'));
  ok('no debugger statement shipped', !/\bdebugger\b/.test(js));
}

done();
