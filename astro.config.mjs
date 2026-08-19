// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://oceansensing.org',

  /* A project page under the org's domain, so everything is served from a
     subdirectory. Nothing here may write a root-absolute internal URL by
     hand: `import.meta.env.BASE_URL` is the only correct prefix, and
     `test:pages` reads the built HTML for links that forgot it. The one
     that is not a link and so fails silently is the series fetch in
     `lib/series.ts`, which asks for `${base}/data/<id>.json`. */
  base: '/usv',

  /* **The CSS minifier is esbuild's, because Vite's default one removes a
     prefix iOS still needs.** `cssMinify: true` resolves to Lightning CSS,
     which drops `-webkit-user-select` wherever its compatibility data says
     the unprefixed property is supported — and on iOS it is not, so the
     declaration Safari understands is the one that gets stripped. Leaflet
     carries that prefix and this site has a Leaflet map on three of its
     five pages. */
  vite: { build: { cssMinify: 'esbuild' } },

  /* A Content Security Policy as a `<meta>` element, because GitHub Pages
     serves headers nobody here controls.
   *
   * **`connect-src` is `'self'` alone, and that is the whole point of the
   * baked build.** The sibling glider site has to allow `https:` because
   * its ERDDAP client takes a server base URL and fetches from it in the
   * reader's browser. This site cannot do that — `data.pmel.noaa.gov`
   * sends no `Access-Control-Allow-Origin` on any response, so the data is
   * fetched by the build instead and served from this origin. The policy
   * that falls out is much narrower than the one a live client needs, and
   * a later edit that reintroduces a cross-origin fetch will be stopped
   * here rather than working in Node and failing in a browser.
   *
   * `script-src` without `unsafe-inline` is the other point. Every page
   * puts text from somewhere else on screen — dataset titles, institutions
   * and summaries written by whoever published them to PMEL. All of it is
   * built as DOM rather than markup, so none of it can inject anything
   * today; this is what still holds if a later edit adds a sink.
   *
   * Two directives are wider than `'self'`:
   *
   *   - `img-src 'self' data: blob: https:` — basemap tiles come from Esri,
   *     plus `data:`/`blob:` for the PNG export's round trip through a
   *     canvas.
   *   - `style-src-attr 'unsafe-inline'` — Leaflet positions every pane and
   *     marker with a `style` attribute. Scoped to attributes alone, so
   *     `style-src-elem` keeps its hashes and a stylesheet still cannot be
   *     injected. */
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'",
        "img-src 'self' data: blob: https:",
        // `data:` because @fontsource inlines its small woff2 subsets as
        // data URIs. Without it every page loads in the fallback face.
        "font-src 'self' data:",
        "connect-src 'self'",
      ],
      styleDirective: {
        resources: [{ resource: "'unsafe-inline'", kind: 'attribute' }],
      },
    },
  },
});
