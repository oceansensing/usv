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
import { reachableRuns, type Fix } from './reachable.ts';
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

export interface FleetMapOptions {
  /**
   * What colour a record's track takes.
   *
   * The fleet page colours by vendor — three colours, so a reader can see at
   * a glance which company built what. A campaign page colours by the
   * vehicle's place in its roster, so the list beside the map *is* the
   * legend. Same map, different question.
   */
  colour?: (record: CatalogEntry, index: number, total: number) => string;
  /** How many tracks to draw before counting the rest. */
  max?: number;
}

/**
 * **This is what draws several tracks, and `makeTrack` is not.**
 *
 * `makeTrack` is one deployment's path coloured by a variable, and it does
 * two things that are right for that and wrong for a fleet: it *skips* a
 * non-finite position rather than lifting the pen, and it **sorts every
 * point by time**. Handed several vehicles concatenated together, the sort
 * interleaves them and the map draws a zigzag between vehicles hundreds of
 * kilometres apart — which is exactly what the campaign page did before it
 * was moved here. One polyline per record is the only shape that cannot do
 * that.
 */
export function makeFleetMap(
  element: HTMLElement, status: HTMLElement, options: FleetMapOptions = {},
): FleetMap {
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
  /** The bounds the last `show` asked for, kept so the fit can be applied
      again once the container has a size to fit them to. */
  let wanted: L.LatLngBounds | null = null;

  /**
   * Fit the map to `wanted`, if there is anything to fit it to.
   *
   * **Guarded on the container having a size.** `fitBounds` on a zero-width
   * element asks Leaflet what zoom shows the world in no pixels, and the
   * answer is the maximum — so the map lands at zoom 13 on a point in the
   * open ocean, with two tiles and no tracks in view. `invalidateSize` then
   * restores the size but *keeps the centre and zoom*, so nothing ever
   * recovers it. A background tab, a collapsed panel and a hidden pane all
   * reach this.
   */
  function applyFit(): void {
    if (!wanted?.isValid()) return;
    if (element.clientWidth < 1 || element.clientHeight < 1) return;
    map.fitBounds(wanted, { padding: [24, 24] });
  }

  new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = element;
    if (w === lastWidth && h === lastHeight) return;
    const wasUnsized = lastWidth < 1 || lastHeight < 1;
    lastWidth = w;
    lastHeight = h;
    map.invalidateSize();
    /* Coming from no size at all, whatever view was computed was computed
       against nothing. This is the only chance to put it right. */
    if (wasUnsized) applyFit();
  }).observe(element);

  async function show(records: CatalogEntry[]): Promise<void> {
    const mine = ++generation;
    lines.clearLayers();
    dots.clearLayers();

    const drawable = records.filter((d) => d.kind !== 'files' && d.rows);
    const chosen = drawable.slice(0, options.max ?? MAX_TRACKS);
    if (!chosen.length) {
      status.textContent = drawable.length === 0 && records.length
        ? 'No track has been built for these records.'
        : 'No records match.';
      return;
    }

    const bounds = L.latLngBounds([]);
    let done = 0;
    const say = () => {
      /* **The denominator is what matched, not what was picked.** "40 of 40
         tracks · 112 more match and are not drawn" reads as *all of them*
         and then contradicts itself in the same breath. While the files are
         arriving the useful number is progress; once they have all arrived
         the useful number is coverage. */
      const capped = drawable.length > chosen.length;
      status.textContent = done < chosen.length
        ? `${done} of ${chosen.length} tracks…`
        : capped
          ? `${chosen.length} of ${drawable.length} matching tracks drawn`
            + ` — the ${MAX_TRACKS} most recent`
          : `${chosen.length} track${chosen.length === 1 ? '' : 's'}`;
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
          drawTrack(series, d, i, chosen.length);
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

    /* Last, after every track is in: the view is fitted to what actually
       arrived, not to what was asked for. Which means the map sits at its
       opening view while the files download — a full fleet is 40 requests —
       and jumps to the fit when they land. That is the intended behaviour
       and it reads as a bug from a screenshot taken halfway through. */
    wanted = bounds.isValid() ? bounds : null;
    applyFit();

    function drawTrack(
      series: Awaited<ReturnType<typeof loadSeries>>, d: CatalogEntry,
      index: number, total: number,
    ) {
      const lat = series.columns.get('lat')!;
      const lon = series.columns.get('lon')!;
      const time = series.columns.get('time')!;
      const fixes: Fix[] = [];
      /* A track on a fleet map is a shape, not a measurement: 400 points is
         past what a 1200 px map resolves, and 153 × 8,000 polyline vertices
         is what stops it panning. */
      const stride = Math.max(1, Math.ceil(series.rows / 400));
      for (let i = 0; i < series.rows; i += stride) {
        const la = lat[i];
        const lo = lon[i];
        /* A fix that is missing, or at the null island, is not a position.
           Skipping it leaves its neighbours adjacent, which is what
           `reachableRuns` then has to judge. */
        if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
        if (la === 0 && lo === 0) continue;
        fixes.push({ lat: la, lon: lo, t: time[i] });
        bounds.extend([la, lo]);
      }
      if (fixes.length < 2) return;

      /* **The pen lifts where the vehicle could not have sailed.** Three
         2024 Saildrones were recovered in the Atlantic and their records
         continue with dock telemetry from Alameda, so a single polyline
         through every fix draws a 4,000 km line across the United States. */
      const runs = reachableRuns(fixes);
      if (!runs.length) return;

      const colour = options.colour
        ? options.colour(d, index, total)
        : VENDOR_COLOR[d.vendor] ?? '#888';

      const label = `${d.vehicle || d.id} · ${d.campaignLabel}`
        + `\n${isoDay(d.start)} → ${isoDay(d.end)} (${duration(d.end - d.start)})`;

      /* **A multi-vehicle record gets its extent, not a path.** Three
         Saildrones surveying one box report in turn, so a line through
         consecutive rows is a scribble none of them sailed. The area they
         worked is true and is what is drawn; the route is not. */
      if (d.multiVehicle) {
        const box = L.polygon([
          [d.south, d.west], [d.south, d.east], [d.north, d.east], [d.north, d.west],
        ], {
          color: colour, weight: 1.5, opacity: 0.7, fillOpacity: 0.05, dashArray: '4 4',
          className: 'track-hit',
        }).addTo(lines);
        box.bindTooltip(`${label}\nseveral vehicles — the area they worked, not a track`,
          { sticky: true });
        box.on('click', () => pick?.(d.id));
        bounds.extend(box.getBounds());
        return;
      }

      /* **Two rules stand between an invisible hit line and a clickable
         one.** A 2 px stroke is very hard to hit and a diagonal one is
         worse, so each track carries a fat transparent line beneath it —
         and `stroke-opacity: 0` paints nothing, which under SVG's default
         `pointer-events: visiblePainted` makes it a target nowhere at all.
         `pointer-events: stroke` is what means "the stroke area whatever
         the paint", and the selector must out-specify Leaflet's own
         `.leaflet-interactive { pointer-events: auto }`. See the stylesheet
         rule on `path.track-hit`. */
      const cuts = runs.length - 1;
      const tip = cuts
        ? `${label}\n${cuts} break${cuts === 1 ? '' : 's'} where the vehicle could `
          + 'not have sailed between fixes'
        : label;

      for (const run of runs) {
        const line = run.map((f) => [f.lat, f.lon] as [number, number]);
        const hit = L.polyline(line, {
          color: colour, weight: 14, opacity: 0, className: 'track-hit',
        }).addTo(lines);
        L.polyline(line, { color: colour, weight: 2, opacity: 0.85 }).addTo(lines);
        hit.bindTooltip(tip, { sticky: true });
        hit.on('click', () => pick?.(d.id));
      }

      /* **The dot stays.** A track has two ends and nothing on it says which
         is recent, and "where is it now" is the question a fleet map is
         opened with. */
      const lastRun = runs[runs.length - 1];
      const last: [number, number] = [
        lastRun[lastRun.length - 1].lat, lastRun[lastRun.length - 1].lon,
      ];
      const live = isActive(d);
      L.circleMarker(last, {
        radius: live ? 5 : 3.5,
        color: colour,
        weight: live ? 2 : 1,
        fillColor: colour,
        fillOpacity: live ? 0.95 : 0.35,
      }).addTo(dots).bindTooltip(tip, { sticky: true })
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
