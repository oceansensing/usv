/**
 * A campaign: the vehicles that flew together, on one map and one axis.
 *
 * **This page is the reason `@c4po/usv-vars` exists.** Putting a Saildrone
 * and an Oshen on one set of axes means resolving `sbe37_temperature_filtered`
 * and `sst_mean` to the same quantity, converting knots to m/s, and adjusting
 * two anemometer heights to 10 m — and all of that happened at build time, so
 * by here both vehicles simply carry a column called `sea_temperature` in °C.
 *
 * ## How several vehicles reach one plot
 *
 * The plot engine draws one series. Several vehicles are drawn by
 * **concatenating them with a gap between**: the engine already lifts its pen
 * over a NaN rather than drawing a chord across it, so one series with a NaN
 * row between each vehicle is N lines. The colour axis carries the vehicle's
 * index, which makes the legend a colour bar the reader can read against the
 * list beside it.
 *
 * The alternative — one plot call per vehicle onto shared axes — would need
 * the engine to expose its projection and accumulate, which is a much larger
 * change to a piece of code shared with another site.
 */

import { makeFigure, type Figure, type Source } from './figure.ts';
import { makeFleetMap, type FleetMap } from './fleet.ts';
import type { Plottable } from './variables.ts';
import {
  duration, isActive, isoDay, loadCatalog, loadSeries,
  type Campaign, type CatalogEntry, type Series,
} from './data.ts';
import { withBase } from './url.ts';

/** How many vehicles are drawn at once. A cohort is typically eight to
 *  twenty; past this the comparison axis is a thicket and the fetch is most
 *  of the archive. Printed when it bites. */
const MAX_VEHICLES = 24;

/** The quantities offered for comparison, in the order a reader wants them.
 *  Only those the whole cohort shares are listed — a menu entry that draws
 *  one vehicle is not a comparison. */
const COMPARABLE = [
  'air_pressure', 'wind_speed', 'u10', 'sea_temperature', 'air_temperature',
  'relative_humidity', 'salinity', 'wave_height', 'wind_gust', 'dewpoint',
  'sigma0', 'chlorophyll', 'oxygen_concentration',
];

export function makeCampaignPage(root: Document): { load(slug: string | null): Promise<void> } {
  const at = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;

  /* Two elements, deliberately: the wrapper is what is shown or hidden, and
     the list inside it is what is filled. One element doing both means the
     module has to know about the heading and the lede that sit beside the
     list. */
  const listWrap = at<HTMLElement>('[data-campaigns-wrap]');
  const listEl = at<HTMLElement>('[data-campaigns]');
  const oneEl = at<HTMLElement>('[data-campaign]');
  const titleEl = at<HTMLElement>('[data-title]');
  const backEl = at<HTMLElement>('[data-back]');
  const factsEl = at<HTMLElement>('[data-facts]');
  const rosterEl = at<HTMLElement>('[data-roster]');
  const statusEl = at<HTMLElement>('[data-status]');
  const pickEl = at<HTMLSelectElement>('[data-quantity]');

  let map: FleetMap | null = null;
  let figure: Figure | null = null;
  let loaded: Array<{ entry: CatalogEntry; series: Series }> = [];

  async function load(slug: string | null): Promise<void> {
    const catalog = await loadCatalog();
    if (!slug) {
      listWrap.hidden = false;
      oneEl.hidden = true;
      backEl.hidden = true;
      drawList(catalog.campaigns, catalog.datasets);
      return;
    }

    const campaign = catalog.campaigns.find((c) => c.slug === slug);
    if (!campaign) {
      listWrap.hidden = false;
      oneEl.hidden = true;
      backEl.hidden = true;
      const missing = document.createElement('p');
      missing.className = 'error';
      missing.textContent = `No campaign called “${slug}”. Every one that exists is below.`;
      listWrap.prepend(missing);
      drawList(catalog.campaigns, catalog.datasets);
      return;
    }

    listWrap.hidden = true;
    oneEl.hidden = false;
    backEl.hidden = false;
    document.title = `${campaign.label} · USV`;
    titleEl.textContent = campaign.label;

    /* **A table of several vehicles is not a vehicle.** Every campaign that
       has one also has the per-vehicle records it aggregates, so including
       it would put the same measurements on the axis twice — once as
       themselves and once interleaved with their neighbours' — and add a
       line to the roster that no instrument produced. */
    const members = catalog.datasets
      .filter((d) => campaign.datasets.includes(d.id) && d.rows && !d.multiVehicle)
      .sort((a, b) => a.vehicle.localeCompare(b.vehicle));
    const aggregate = catalog.datasets.filter(
      (d) => campaign.datasets.includes(d.id) && d.multiVehicle);
    drawFacts(campaign, members, catalog.datasets.filter(
      (d) => campaign.datasets.includes(d.id),
    ), aggregate);

    const chosen = members.slice(0, MAX_VEHICLES);
    statusEl.textContent = `loading ${chosen.length} vehicles…`;

    /* One polyline per vehicle, from the same map the fleet page uses.
       `makeTrack` cannot do this: it sorts every point by time, so several
       vehicles concatenated together come out interleaved and the map draws
       a zigzag between vehicles hundreds of kilometres apart. */
    if (!map) {
      map = makeFleetMap(at<HTMLElement>('[data-map]'), statusEl, {
        colour: (_d, i, total) => colourAt(i, total),
        max: MAX_VEHICLES,
      });
      map.onPick((id) => {
        window.location.href = `${withBase('/vehicle/')}?dataset=${encodeURIComponent(id)}`;
      });
    }

    /* The map draws first and from the catalog, so a reader sees where the
       cohort went while the series arrive. Both go through the same
       `loadSeries` cache, so nothing is fetched twice. */
    await map.show(chosen);

    loaded = [];
    for (const entry of chosen) {
      try {
        loaded.push({ entry, series: await loadSeries(entry.id) });
      } catch {
        /* One vehicle's file failing is not the campaign failing. */
      }
    }

    drawRoster();
    fillQuantities();
    drawComparison();
  }

  /* ------------------------------------------------------------- list -- */

  function drawList(campaigns: Campaign[], datasets: CatalogEntry[]): void {
    const counts = new Map<string, CatalogEntry[]>();
    for (const d of datasets) {
      if (d.kind === 'files') continue;
      const list = counts.get(d.campaign) ?? [];
      list.push(d);
      counts.set(d.campaign, list);
    }

    listEl.replaceChildren(...campaigns.map((c) => {
      const members = counts.get(c.slug) ?? [];
      const li = document.createElement('li');
      li.className = 'campaign';

      const a = document.createElement('a');
      a.href = `?id=${encodeURIComponent(c.slug)}`;
      a.className = 'figure-title';
      a.textContent = c.label;
      li.append(a);

      const meta = document.createElement('p');
      meta.className = 'muted';
      meta.textContent = `${members.length} vehicle${members.length === 1 ? '' : 's'} · `
        + `${c.vendors.join(', ')} · `
        + `${c.start ? isoDay(c.start) : '—'} → ${c.end ? isoDay(c.end) : '—'}`;
      li.append(meta);

      const live = members.filter((d) => isActive(d)).length;
      if (live) {
        const tag = document.createElement('span');
        tag.className = 'live';
        tag.textContent = `${live} reporting now`;
        li.append(tag);
      }
      return li;
    }));
  }

  /* -------------------------------------------------------------- one -- */

  function drawFacts(
    c: Campaign, members: CatalogEntry[], all: CatalogEntry[],
    aggregate: CatalogEntry[] = [],
  ): void {
    const findings = members.reduce((sum, d) => sum + (d.findings ?? 0), 0);
    const worstCount = members.filter((d) => d.severity === 'high').length;
    const rows: Array<[string, string]> = [
      ['Vehicles', `${all.length}`
        + (all.length !== members.length ? ` (${members.length} built)` : '')],
      ['Vendors', c.vendors.join(', ')],
      ['Span', `${c.start ? isoDay(c.start) : '—'} → ${c.end ? isoDay(c.end) : '—'}`
        + (c.start && c.end ? ` (${duration(c.end - c.start)})` : '')],
      ['Reporting now', String(members.filter((d) => isActive(d)).length)],
      ['Findings', `${findings} across the cohort`
        + (worstCount ? `, ${worstCount} record${worstCount === 1 ? '' : 's'} with a high-severity one` : '')],
    ];
    if (aggregate.length) {
      rows.push(['Also published', `${aggregate.length} multi-vehicle table`
        + `${aggregate.length === 1 ? '' : 's'}, not compared here`]);
    }
    factsEl.replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
  }

  function drawRoster(): void {
    rosterEl.replaceChildren(...loaded.map(({ entry }, i) => {
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = colourFor(i);
      const a = document.createElement('a');
      a.href = `${withBase('/vehicle/')}?dataset=${encodeURIComponent(entry.id)}`;
      a.textContent = entry.vehicle || entry.id;
      const note = document.createElement('span');
      note.className = 'muted';
      note.textContent = ` ${entry.vendor}`
        + (entry.severity ? ` · ${entry.severity}` : '')
        + (isActive(entry) ? ' · live' : '');
      li.append(swatch, a, note);
      return li;
    }));
  }

  /** The colour a vehicle takes, matching what the comparison plot draws.
   *  Spread across the viridis ramp the plot uses for the vehicle index, so
   *  the map, the roster and the figure all agree without any of them having
   *  to ask the others. */
  function colourFor(i: number): string {
    return colourAt(i, loaded.length);
  }

  function fillQuantities(): void {
    /* Only the quantities every loaded vehicle carries. A menu entry that
       draws one vehicle out of twelve is not a comparison, and finding that
       out after choosing it is worse than not offering it. */
    const shared = COMPARABLE.filter((key) =>
      loaded.length > 0 && loaded.every(({ series }) => series.columns.has(key)));
    const keep = pickEl.value;
    pickEl.replaceChildren(...shared.map((key) => {
      const meta = loaded[0].series.doc.variables.find((v) => v.key === key);
      const option = document.createElement('option');
      option.value = key;
      option.textContent = meta
        ? (meta.units ? `${meta.label} (${meta.units})` : meta.label)
        : key;
      return option;
    }));
    if (shared.includes(keep)) pickEl.value = keep;
    pickEl.disabled = shared.length === 0;
  }

  function drawComparison(): void {
    const key = pickEl.value;
    if (!key || !loaded.length) return;

    const total = loaded.reduce((n, { series }) => n + series.rows + 1, 0);
    const time = new Float64Array(total);
    const value = new Float64Array(total);
    const index = new Float64Array(total);
    let w = 0;
    loaded.forEach(({ series }, k) => {
      const t = series.columns.get('time')!;
      const v = series.columns.get(key)!;
      for (let i = 0; i < series.rows; i++) {
        time[w] = t[i]; value[w] = v[i]; index[w] = k;
        w++;
      }
      /* The gap. The engine lifts its pen over a NaN rather than drawing a
         chord, which is what turns one series into N lines. */
      time[w] = NaN; value[w] = NaN; index[w] = NaN;
      w++;
    });

    /* **The column is always called `value`, whatever quantity it holds.**
       The figure binds its axes to column *names* at construction, so a
       menu that renamed the column would need the figure torn down and
       rebuilt on every change — which means new listeners on the same DOM
       and the reader's colormap and limits thrown away. One stable name and
       a changing label costs nothing and keeps both. */
    const meta = loaded[0].series.doc.variables.find((v) => v.key === key);
    const variables: Plottable[] = [
      { name: 'time', label: 'Time', short: 'time', units: '', colormap: 'cmo.thermal',
        rank: 1, derived: false, section: false },
      { name: 'value', label: meta?.label ?? key, short: meta?.short ?? key,
        units: meta?.units ?? '', colormap: meta?.colormap ?? 'viridis', rank: 2,
        derived: Boolean(meta?.derived), floor: meta?.floor ?? undefined, section: true },
      { name: 'vehicle', label: 'Vehicle', short: 'veh', units: '', colormap: 'viridis',
        rank: 3, derived: false, section: false },
    ];
    const source: Source = {
      columns: new Map([['time', time], ['value', value], ['vehicle', index]]),
      rows: total,
      variables,
      timeVar: 'time',
    };

    if (!figure) {
      figure = makeFigure(at('[data-compare]'), {
        x: 'time', y: 'value', c: 'vehicle', style: 'line', height: 420, map: 'viridis',
        note: 'Each line is one vehicle, coloured by its place in the roster. '
          + 'Every vehicle here was resolved to the same canonical quantity and '
          + 'the same units before being drawn, which is the only reason a '
          + 'Saildrone and an Oshen can share this axis.',
      });
    }
    figure.update(source);
  }

  pickEl.addEventListener('change', () => {
    drawComparison();
    const url = new URL(window.location.href);
    url.searchParams.set('q', pickEl.value);
    window.history.replaceState(null, '', url);
  });

  return { load };
}

function colourAt(i: number, total: number): string {
  const n = Math.max(total - 1, 1);
  return VIRIDIS[Math.round((i / n) * (VIRIDIS.length - 1))];
}

/** Ten samples of viridis, for the roster swatches. Taken from the same
    table the plot engine uses so the two cannot drift apart by more than the
    sampling. */
const VIRIDIS = [
  '#440154', '#482878', '#3e4989', '#31688e', '#26828e',
  '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725',
];

export { MAX_VEHICLES };
