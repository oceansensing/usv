/**
 * The fleet page: a map of every track, and a table that filters with it.
 *
 * The map and the table are one thing, not two. Narrowing the search narrows
 * the map, and clicking a track opens that vehicle — so the reader never has
 * to hold a dataset id in their head to get from one to the other.
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { sample } from '@c4po/plot';
import {
  type CatalogEntry, duration, isActive, isoDay, loadCatalog, loadSeries,
} from './data.ts';
import { withBase } from './url.ts';
import { VENDOR_COLOR } from '../config.ts';

/**
 * How many tracks are drawn at once.
 *
 * Each is one fetch of that vehicle's series file, and the files run from
 * 200 KB to 2 MB — so drawing all 153 would be most of the archive
 * downloaded to show a shape. The cap is printed beside the count rather
 * than applied silently: a map that quietly shows sixty of a hundred and
 * fifty tracks is a map that answers a different question than the one the
 * filter asked.
 */
const MAX_TRACKS = 40;

/** Fetches in flight. Three, matching the sibling site's measurement that a
    fourth parallel request to an ERDDAP buys nothing; here the server is
    GitHub's CDN and the reason is the reader's connection instead. */
const CONCURRENCY = 3;

const TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}';
export const ATTRIBUTION = 'Esri — GEBCO, NOAA, National Geographic';

export interface Filters {
  text: string;
  vendors: Set<string>;
  campaign: string;
  year: string;
  activeOnly: boolean;
  severity: string;
}

export function emptyFilters(): Filters {
  return {
    text: '', vendors: new Set(), campaign: '', year: '', activeOnly: false, severity: '',
  };
}

/** Whether one record survives the filters. */
export function matches(d: CatalogEntry, f: Filters, now: number): boolean {
  if (d.kind === 'files') return false;
  if (f.vendors.size && !f.vendors.has(d.vendor)) return false;
  if (f.campaign && d.campaign !== f.campaign) return false;
  if (f.year && !yearsOf(d).includes(f.year)) return false;
  if (f.activeOnly && !isActive(d, now)) return false;
  if (f.severity && d.severity !== f.severity) return false;
  if (f.text) {
    const hay = `${d.id} ${d.vehicle} ${d.title} ${d.institution} ${d.campaignLabel}`
      .toLowerCase();
    /* Every word, in any order. A reader typing "oshen 2026" means both, and
       a substring match on the whole phrase finds neither. */
    for (const word of f.text.toLowerCase().split(/\s+/)) {
      if (word && !hay.includes(word)) return false;
    }
  }
  return true;
}

/** Every calendar year a deployment touched, so a mission running into
    January is found under both. */
export function yearsOf(d: CatalogEntry): string[] {
  if (!Number.isFinite(d.start) || !Number.isFinite(d.end)) return [];
  const first = new Date(d.start * 1000).getUTCFullYear();
  const last = new Date(d.end * 1000).getUTCFullYear();
  const out: string[] = [];
  for (let y = first; y <= last; y++) out.push(String(y));
  return out;
}

/* ----------------------------------------------------------------- map -- */

export interface FleetMap {
  /** Draw the tracks for these records, replacing what is there. */
  show(records: CatalogEntry[]): Promise<void>;
  /** Called with a dataset id when a reader clicks a track or a dot. */
  onPick(handler: (id: string) => void): void;
  readonly map: L.Map;
}

export function makeFleetMap(element: HTMLElement, status: HTMLElement): FleetMap {
  /* `fadeAnimation: false` because Leaflet drives the fade from
     `requestAnimationFrame`, which a background tab never runs — so tiles
     that finished downloading sit at `opacity: 0` until the tab is focused. */
  const map = L.map(element, { worldCopyJump: true, fadeAnimation: false })
    .setView([25, -60], 3);
  /* `crossOrigin` is what makes a PNG export possible at all: drawing an
     image fetched without CORS taints the canvas, and a tainted canvas
     throws on `toBlob` — at the very end, after all the work. */
  L.tileLayer(TILES, { maxZoom: 13, crossOrigin: 'anonymous', attribution: ATTRIBUTION })
    .addTo(map);

  const lines = L.layerGroup().addTo(map);
  const dots = L.layerGroup().addTo(map);
  let pick: ((id: string) => void) | undefined;
  /** Bumped on every `show`, so a slow fetch from a superseded filter cannot
      draw itself over the current one. */
  let generation = 0;

  /* Leaflet measures its container once, at construction, and this map is
     built while the page is still assembling. Guarded on the size actually
     changing: `invalidateSize` moves Leaflet's own elements, the observer
     sees that as another resize, and the unguarded version re-enters every
     frame. */
  let lastWidth = 0;
  let lastHeight = 0;
  new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = element;
    if (w === lastWidth && h === lastHeight) return;
    lastWidth = w;
    lastHeight = h;
    map.invalidateSize();
  }).observe(element);

  async function show(records: CatalogEntry[]): Promise<void> {
    const mine = ++generation;
    lines.clearLayers();
    dots.clearLayers();

    const drawable = records.filter((d) => d.kind !== 'files' && d.rows);
    const chosen = drawable.slice(0, MAX_TRACKS);
    if (!chosen.length) {
      status.textContent = drawable.length === 0 && records.length
        ? 'No track has been built for these records.'
        : 'No records match.';
      return;
    }

    const bounds = L.latLngBounds([]);
    let done = 0;
    const say = () => {
      status.textContent = `${done} of ${chosen.length} tracks`
        + (drawable.length > chosen.length
          /* Printed, never silent. */
          ? ` · ${drawable.length - chosen.length} more match and are not drawn`
          : '');
    };
    say();

    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, chosen.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= chosen.length) return;
        const d = chosen[i];
        try {
          const series = await loadSeries(d.id);
          if (mine !== generation) return;
          drawTrack(series, d);
        } catch {
          /* One vehicle's file failing is not the map failing. The count
             says how many arrived. */
        }
        done++;
        if (mine === generation) say();
      }
    });
    await Promise.all(workers);
    if (mine !== generation) return;

    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });

    function drawTrack(series: Awaited<ReturnType<typeof loadSeries>>, d: CatalogEntry) {
      const lat = series.columns.get('lat')!;
      const lon = series.columns.get('lon')!;
      const points: Array<[number, number]> = [];
      /* A track on a fleet map is a shape, not a measurement: 400 points is
         past what a 1200 px map resolves, and 153 × 8,000 polyline vertices
         is what stops it panning. */
      const stride = Math.max(1, Math.ceil(series.rows / 400));
      for (let i = 0; i < series.rows; i += stride) {
        const la = lat[i];
        const lo = lon[i];
        /* A missing fix is skipped rather than drawn: position drops out of
           telemetry regularly in this archive, and joining across the gap
           draws a line the vehicle did not sail. */
        if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
        if (la === 0 && lo === 0) continue;
        points.push([la, lo]);
        bounds.extend([la, lo]);
      }
      if (points.length < 2) return;

      const colour = VENDOR_COLOR[d.vendor] ?? '#888';

      /* **Two rules stand between an invisible hit line and a clickable
         one.** A 2 px stroke is very hard to hit and a diagonal one is
         worse, so each track carries a fat transparent line beneath it —
         and `stroke-opacity: 0` paints nothing, which under SVG's default
         `pointer-events: visiblePainted` makes it a target nowhere at all.
         `pointer-events: stroke` is what means "the stroke area whatever
         the paint", and the selector must out-specify Leaflet's own
         `.leaflet-interactive { pointer-events: auto }`. See the stylesheet
         rule on `path.track-hit`. */
      const hit = L.polyline(points, {
        color: colour, weight: 14, opacity: 0, className: 'track-hit',
      }).addTo(lines);
      L.polyline(points, { color: colour, weight: 2, opacity: 0.85 }).addTo(lines);

      const label = `${d.vehicle || d.id} · ${d.campaignLabel}`
        + `\n${isoDay(d.start)} → ${isoDay(d.end)} (${duration(d.end - d.start)})`;
      hit.bindTooltip(label, { sticky: true });
      hit.on('click', () => pick?.(d.id));

      /* **The dot stays.** A track has two ends and nothing on it says which
         is recent, and "where is it now" is the question a fleet map is
         opened with. */
      const last = points[points.length - 1];
      const live = isActive(d, Date.now() / 1000);
      L.circleMarker(last, {
        radius: live ? 5 : 3.5,
        color: colour,
        weight: live ? 2 : 1,
        fillColor: colour,
        fillOpacity: live ? 0.95 : 0.35,
      }).addTo(dots).bindTooltip(label, { sticky: true })
        .on('click', () => pick?.(d.id));
    }
  }

  if (import.meta.env.DEV) {
    /* A handle for poking at the map from the console while developing.
       Dropped from the production bundle by the `DEV` guard, which Vite
       replaces with `false` and then tree-shakes. */
    (globalThis as unknown as Record<string, unknown>).__fleetMap = map;
  }

  return {
    show,
    onPick(handler) { pick = handler; },
    map,
  };
}

export { MAX_TRACKS, loadCatalog, sample };
