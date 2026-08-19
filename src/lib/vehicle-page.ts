/**
 * One vehicle: the track, a stack of time series, a scatter, and what is
 * wrong with the record.
 *
 * The markup is `pages/vehicle.astro`; this is everything that happens once
 * a reader opens it. Kept out of the page so it can be read without wading
 * through HTML, and so the campaign page can reuse the parts that are not
 * about one vehicle.
 *
 * ## The stack is cloned, and the clone has to carry its scope
 *
 * A compiled Astro component cannot be instantiated at runtime, and the
 * number of series on screen is the reader's choice — so the stack is built
 * by cloning a rendered `PlotFigure`. The prototype is a **real instance in
 * the page**, not a `<template>`: Astro stamps its scoping attribute onto
 * elements it renders, `cloneNode` copies attributes, and a clone taken from
 * a template would carry none and lose every scoped rule.
 */

import { makeFigure, type Figure, type Source } from './figure.ts';
import { makeTrack, type Track } from './track.ts';
import { makeTrackLegend } from './track-legend.ts';
import { plottable, type Plottable } from './variables.ts';
import {
  duration, isoDay, isoMinute, loadCatalog, loadSeries, since,
  type CatalogEntry, type Finding, type Series,
} from './data.ts';
import { PMEL, SEVERITIES } from '../config.ts';
import { withBase } from './url.ts';

/** The quantities a vehicle page opens with, where the record has them.
 *
 *  A reader arriving at a hurricane mission wants the pressure and the wind
 *  before the magnetometer, and this is that order. Anything absent is
 *  skipped rather than drawn empty. */
const DEFAULT_STACK = [
  'air_pressure', 'wind_speed', 'sea_temperature', 'air_temperature',
  'salinity', 'wave_height', 'chlorophyll',
];

/** How many series the stack draws at once. Past six the shared time axis
    stops being readable on one screen, which is the whole point of it. */
const MAX_STACK = 6;

export interface VehiclePage {
  load(id: string): Promise<void>;
}

export function makeVehiclePage(root: Document | HTMLElement): VehiclePage {
  const at = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;

  const titleEl = at<HTMLElement>('[data-title]');
  const subtitleEl = at<HTMLElement>('[data-subtitle]');
  const factsEl = at<HTMLElement>('[data-facts]');
  const stackEl = at<HTMLElement>('[data-stack]');
  const protoEl = at<HTMLElement>('[data-proto]');
  const chipsEl = at<HTMLElement>('[data-chips]');
  const qcEl = at<HTMLElement>('[data-qc]');
  const qcNoteEl = at<HTMLElement>('[data-qcnote]');
  const provEl = at<HTMLElement>('[data-provenance]');
  const errorEl = at<HTMLElement>('[data-error]');
  const windowEl = at<HTMLElement>('[data-window]');
  const windowLabel = at<HTMLElement>('[data-window-label]');
  const siblingsEl = at<HTMLElement>('[data-siblings]');
  const siblingsWrap = at<HTMLElement>('[data-siblings-wrap]');
  const siblingsHead = at<HTMLElement>('[data-siblings-head]');
  const contentEl = at<HTMLElement>('[data-content]');
  const trackWrap = at<HTMLElement>('[data-track-wrap]');
  const noTrackEl = at<HTMLElement>('[data-no-track]');
  const interleavedEl = at<HTMLElement>('[data-interleaved]');

  let series: Series | null = null;
  /** Taken from the catalog rather than the series file, because the catalog
      is always current and a series written before this field existed does
      not carry it. */
  let multiVehicle = false;
  let variables: Plottable[] = [];
  let track: Track | null = null;
  let scatter: Figure | null = null;
  const stack = new Map<string, { figure: Figure; root: HTMLElement }>();
  let chosen: string[] = [];

  const source = (): Source | null => (series
    ? { columns: series.columns, rows: series.rows, variables, timeVar: 'time' }
    : null);

  const legend = makeTrackLegend(root, {
    track: () => track,
    source,
    axes: () => ({ timeVar: 'time', latVar: 'lat', lonVar: 'lon' }),
    onChange: () => save(),
    title: () => (series ? `${series.doc.vehicle || series.doc.id} — track` : 'track'),
  });

  async function load(id: string): Promise<void> {
    try {
      series = await loadSeries(id);
    } catch (error) {
      /* One record in the archive reaches this: the high-resolution Chance
         product, which PMEL will not serve to the build. The page says so
         and — the part that matters — sends the reader to the ERDDAP, where
         the data actually is. A dead end that names a file is worse than no
         page at all. */
      document.title = `${id} · USV`;
      titleEl.textContent = id;
      subtitleEl.textContent = 'This record has no series on this site.';
      errorEl.hidden = false;
      errorEl.replaceChildren();
      const p = document.createElement('p');
      p.append('The build could not fetch this record from PMEL, so there is nothing '
        + 'here to draw. Everything about it is still on ');
      const a = document.createElement('a');
      a.href = `${PMEL}/tabledap/${encodeURIComponent(id)}.html`;
      a.textContent = 'its own ERDDAP page';
      p.append(a, ', which is where this site got the rest.');
      const why = document.createElement('p');
      why.className = 'muted';
      why.textContent = `The fetch reported: ${(error as Error).message}`;
      errorEl.append(p, why);
      contentEl.hidden = true;
      return;
    }
    errorEl.hidden = true;
    contentEl.hidden = false;

    const doc = series.doc;
    variables = plottable(doc.variables);

    document.title = `${doc.vehicle || doc.id} · USV`;
    titleEl.textContent = doc.vehicle || doc.id;
    subtitleEl.textContent = doc.title;

    drawFacts();
    drawProvenance();
    drawQc();
    void drawSiblings(id, doc.vehicle);

    /* **A multi-vehicle record has no track.** Three Saildrones surveying
       one box report in turn, so a line through consecutive rows is a
       scribble none of them sailed. The measurements below are real and are
       drawn; the map is replaced by a sentence saying why there is none. */
    const entry = await catalogEntry(id);
    multiVehicle = Boolean(entry?.multiVehicle ?? doc.multiVehicle);
    if (multiVehicle) {
      trackWrap.hidden = true;
      noTrackEl.hidden = false;
      /* Said twice, above the map and above the series, because they are two
         different claims and a reader who scrolls past the first one is
         exactly the reader who needs the second. */
      interleavedEl.hidden = false;
    } else {
      trackWrap.hidden = false;
      noTrackEl.hidden = true;
      interleavedEl.hidden = true;
      /* The map is built once the container has a size. Leaflet measures at
         construction, and this page is still assembling. */
      if (!track) track = makeTrack(at<HTMLElement>('[data-map]'));
    }

    const url = new URL(window.location.href);
    if (track) {
      legend.restore({
        variable: url.searchParams.get('track'),
        colormap: url.searchParams.get('trackmap'),
        range: url.searchParams.get('trackrange'),
      });
      legend.paint();
      track.fit();
    }

    chosen = (url.searchParams.get('vars')?.split(',').filter(Boolean).filter(has))
      ?? DEFAULT_STACK.filter(has).slice(0, MAX_STACK);
    if (!chosen.length) {
      /* A record with none of the defaults — a flux product, an ADCP — still
         gets a stack, of whatever it does carry. */
      chosen = variables.filter((v) => v.section).slice(0, 3).map((v) => v.name);
    }

    drawChips();
    drawStack();
    drawScatter();

    at<HTMLButtonElement>('[data-window-clear]')
      .addEventListener('click', () => clearWindow());

    /* A window in the link is applied once the panels exist to receive it —
       assigning to an input that is not there yet does nothing at all. */
    const t0 = Number(url.searchParams.get('t0'));
    const t1 = Number(url.searchParams.get('t1'));
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
      windowStack(t0, t1);
    }
  }

  const has = (key: string): boolean => Boolean(series?.columns.has(key))
    && variables.some((v) => v.name === key && v.section);

  /* ------------------------------------------------------------ facts -- */

  function drawFacts(): void {
    const d = series!.doc;
    const start = series!.columns.get('time')![0];
    const end = series!.columns.get('time')![series!.rows - 1];
    const rows: Array<[string, string]> = [
      ['Campaign', d.campaignLabel],
      ['Vendor', d.vendor],
      ['Span', `${isoDay(start)} → ${isoDay(end)} (${duration(end - start)})`],
      ['Reporting every', duration(d.cadenceSeconds)],
      ['Points drawn', `${series!.rows.toLocaleString()}`
        + (d.decimated ? ` of ${d.fetchedRows.toLocaleString()} fetched` : '')],
      ['Variables', String(d.variables.length)],
      ['Institution', d.institution],
    ];
    factsEl.replaceChildren(...rows.flatMap(([key, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }));
  }

  function drawProvenance(): void {
    const d = series!.doc;
    provEl.replaceChildren();

    const p = document.createElement('p');
    p.append(`Fetched from PMEL ${since(d.fetched)} (${isoMinute(d.fetched)}) `);
    const a = document.createElement('a');
    a.href = `${PMEL}/tabledap/${encodeURIComponent(d.id)}.html`;
    a.textContent = 'as this dataset';
    p.append(a, '. ');
    p.append(d.decimated
      ? `Fetched at ${Math.round(d.resolutionSeconds / 60)}-minute resolution and drawn `
        + `at every ${Math.ceil(d.fetchedRows / d.rows)}${ordinal(Math.ceil(d.fetchedRows / d.rows))} `
        + 'sample. '
      : 'Drawn at the resolution it was fetched at. ');
    p.append(d.anomalyApplied
      ? 'Absolute Salinity carries the TEOS-10 composition anomaly.'
      : 'Absolute Salinity is shown as Reference Salinity: no anomaly atlas was available.');
    provEl.append(p);

    const licence = d.attributes.license;
    const credit = d.attributes.acknowledgement ?? d.attributes.acknowledgment;
    if (licence || credit) {
      const q = document.createElement('p');
      q.className = 'muted';
      if (credit) q.append(`${credit} `);
      if (licence) q.append(licence);
      provEl.append(q);
    }
  }

  const ordinal = (n: number): string =>
    (n % 10 === 1 && n % 100 !== 11 ? 'st'
      : n % 10 === 2 && n % 100 !== 12 ? 'nd'
        : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

  /* ------------------------------------------------------------ chips -- */

  function drawChips(): void {
    chipsEl.replaceChildren(...variables.filter((v) => v.section).map((v) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = v.label;
      const on = chosen.includes(v.name);
      button.setAttribute('aria-pressed', String(on));
      if (v.derived) button.dataset.derived = 'true';
      button.addEventListener('click', () => {
        if (chosen.includes(v.name)) chosen = chosen.filter((k) => k !== v.name);
        else if (chosen.length < MAX_STACK) chosen = [...chosen, v.name];
        else return;
        drawChips();
        drawStack();
        save();
      });
      return button;
    }));

    const note = document.createElement('span');
    note.className = 'muted chipnote';
    note.textContent = chosen.length >= MAX_STACK
      ? `${MAX_STACK} at a time — deselect one to add another`
      : `${chosen.length} of ${MAX_STACK}`;
    chipsEl.append(note);
  }

  /* ------------------------------------------------------------ stack -- */

  function drawStack(): void {
    /* Figures for variables no longer chosen are removed rather than hidden:
       a hidden figure is still a plot engine holding a copy of the data. */
    for (const [key, entry] of stack) {
      if (!chosen.includes(key)) {
        entry.root.remove();
        stack.delete(key);
      }
    }

    for (const key of chosen) {
      if (stack.has(key)) continue;
      const variable = variables.find((v) => v.name === key);
      if (!variable) continue;

      const clone = protoEl.cloneNode(true) as HTMLElement;
      clone.removeAttribute('data-proto');
      clone.hidden = false;
      /* The `data-figure` attribute belongs to the `PlotFigure` inside the
         clone, not to the wrapper — setting it on both makes every
         `[data-figure]` query return two elements per panel, and a count of
         the figures on screen come back doubled. */
      clone.dataset.stackFor = key;
      const inner = clone.querySelector('[data-figure]');
      if (inner) inner.setAttribute('data-figure', `stack-${key}`);
      const title = clone.querySelector('.figure-title');
      if (title) title.textContent = variable.label;
      stackEl.append(clone);

      const figure = makeFigure(clone, {
        x: 'time',
        y: key,
        style: 'line',
        height: 200,
        note: variable.note,
        /* **Dragging across any panel windows the whole stack.** A shared
           time axis is the reason the panels are stacked at all, and a
           window applied to one of them breaks exactly that. The sibling
           glider site uses this hook to re-fetch at finer resolution; here
           the data is already in hand, so it sets the limits instead — which
           is instant and needs no network. */
        onSelectX: (from, to) => windowStack(from, to),
      });
      figure.update(source()!);
      stack.set(key, { figure, root: clone });
    }

    /* Kept in the reader's chosen order, not insertion order, so removing
       one and adding it back does not shuffle the stack. */
    for (const key of chosen) {
      const entry = stack.get(key);
      if (entry) stackEl.append(entry.root);
    }
  }

  /**
   * Put a time window on every panel, and record it in the URL.
   *
   * The limits are written into the figures' own range boxes rather than
   * held beside them, so a reader can see the window, type over it, and get
   * it back with each figure's Reset — the same rule the boxes already
   * follow for a limit the preset supplies.
   */
  function windowStack(from: number, to: number): void {
    for (const [, entry] of stack) setWindow(entry.root, from, to);
    const url = new URL(window.location.href);
    url.searchParams.set('t0', String(Math.round(from)));
    url.searchParams.set('t1', String(Math.round(to)));
    window.history.replaceState(null, '', url);
    showWindow(from, to);
  }

  /** Clear it, on every panel at once. */
  function clearWindow(): void {
    for (const [, entry] of stack) setWindow(entry.root, NaN, NaN);
    const url = new URL(window.location.href);
    url.searchParams.delete('t0');
    url.searchParams.delete('t1');
    window.history.replaceState(null, '', url);
    showWindow(NaN, NaN);
  }

  /** A `datetime-local` has no zone and `figure.ts` reads it as UTC, which is
      what every clock in this archive is in. */
  const localStamp = (epoch: number): string =>
    new Date(epoch * 1000).toISOString().slice(0, 16);

  function setWindow(root: HTMLElement, from: number, to: number): void {
    const lo = root.querySelector<HTMLInputElement>('[data-plot-x-lo]');
    const hi = root.querySelector<HTMLInputElement>('[data-plot-x-hi]');
    if (!lo || !hi) return;
    const on = Number.isFinite(from) && Number.isFinite(to);
    /* The box is a `number` field until the x axis is time, and assigning a
       date string to a number input is silently dropped. */
    if (lo.type !== 'datetime-local') lo.type = 'datetime-local';
    if (hi.type !== 'datetime-local') hi.type = 'datetime-local';
    lo.value = on ? localStamp(from) : '';
    hi.value = on ? localStamp(to) : '';
    /* `input`, not `change`: the range boxes are wired to `input` in
       `figure.ts`, and a `change` event reaches no listener at all — the
       limits are set, the figure never redraws, and the caption goes on
       reporting the whole record. */
    lo.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function showWindow(from: number, to: number): void {
    const on = Number.isFinite(from) && Number.isFinite(to);
    windowEl.hidden = !on;
    if (on) {
      windowLabel.textContent = `${isoMinute(from)} → ${isoMinute(to)}`;
    }
  }

  function drawScatter(): void {
    const host = at<HTMLElement>('[data-scatter]');
    if (scatter) {
      scatter.update(source()!);
      return;
    }
    /* A T–S diagram where the record has both, and the two most-carried
       quantities otherwise — a scatter of wind against pressure is what a
       hurricane record is read in, and neither is salinity. */
    const x = has('salinity') ? 'salinity' : has('air_pressure') ? 'air_pressure' : 'time';
    const y = has('sea_temperature') ? 'sea_temperature'
      : has('wind_speed') ? 'wind_speed' : chosen[0] ?? 'time';
    scatter = makeFigure(host, { x, y, c: 'time', style: 'dots', dot: 2, height: 380 });
    scatter.update(source()!);
  }

  /* --------------------------------------------------------- siblings -- */

  /**
   * The other products this vehicle published on the same mission.
   *
   * **Eleven Chance datasets carry no observations at all** — they are
   * `EDDTableFromFileNames` listings of CTD casts, echosounder files, CPICS
   * imagery and raw ADCP, whose columns are `url`, `name` and `size`. The
   * site cannot plot them and does not pretend to; it links them, because a
   * reader looking at MC29's surface record is one click from the profile
   * data this archive otherwise has none of, and nothing else on the site
   * would tell them it exists.
   */
  /** This record's own catalog row, or undefined if the catalog cannot be
      read. Cheap: `loadCatalog` fetches once per page however many ask. */
  async function catalogEntry(id: string): Promise<CatalogEntry | undefined> {
    try {
      return (await loadCatalog()).datasets.find((d) => d.id === id);
    } catch {
      return undefined;
    }
  }

  async function drawSiblings(id: string, vehicle: string): Promise<void> {
    let catalog;
    try {
      catalog = await loadCatalog();
    } catch {
      siblingsWrap.hidden = true;
      return;
    }
    const campaign = series!.doc.campaign;

    /* **A record with no vehicle of its own gets the campaign's instead.**
       For a multi-vehicle table the useful neighbours are the per-vehicle
       records covering the same mission — which is what the copy above tells
       the reader to read, so it has to actually list them. */
    const family = vehicle
      ? catalog.datasets.filter(
        (d) => d.vehicle === vehicle && d.campaign === campaign && d.id !== id)
      : catalog.datasets.filter(
        (d) => d.campaign === campaign && d.id !== id && !d.multiVehicle
          && d.kind !== 'files');

    if (!family.length) { siblingsWrap.hidden = true; return; }
    siblingsWrap.hidden = false;
    siblingsHead.textContent = vehicle
      ? 'Also from this vehicle'
      : 'The individual vehicles';

    siblingsEl.replaceChildren(...family
      .sort((a, b) => (a.vehicle || a.id).localeCompare(b.vehicle || b.id))
      .map((d) => sibling(d)));
  }

  function sibling(d: CatalogEntry): HTMLElement {
    const li = document.createElement('li');
    const plottable = d.kind !== 'files';

    const link = document.createElement('a');
    if (plottable) {
      link.href = `${withBase('/vehicle/')}?dataset=${encodeURIComponent(d.id)}`;
      link.textContent = d.variant ? `${d.variant} product`
        : d.vehicle || d.title;
    } else {
      /* Straight to PMEL: there is nothing here to show, and sending a
         reader to a page of this site that says so would waste the click. */
      link.href = `${PMEL}/files/${encodeURIComponent(d.id)}/`;
      link.textContent = `${d.variant || 'files'} — browse on PMEL`;
    }
    li.append(link);

    const note = document.createElement('span');
    note.className = 'muted';
    note.textContent = plottable
      ? ` · ${d.quantities.length} quantities`
      : ' · files, not a time series';
    li.append(note);
    return li;
  }

  /* --------------------------------------------------------------- qc -- */

  function drawQc(): void {
    const report = series!.doc.qc;
    qcNoteEl.textContent = series!.doc.qcNote;

    if (!report.findings.length) {
      const p = document.createElement('p');
      p.className = 'clean';
      p.textContent = 'Nine checks ran over this record and found nothing to report. '
        + 'That is a statement about these checks, not a guarantee about the data.';
      qcEl.replaceChildren(p);
      return;
    }

    const groups = SEVERITIES
      .map((s) => ({ ...s, findings: report.findings.filter((f) => f.severity === s.key) }))
      .filter((g) => g.findings.length);

    qcEl.replaceChildren(...groups.flatMap((g) => {
      const head = document.createElement('h3');
      head.className = 'eyebrow sev';
      head.textContent = `${g.short} — ${g.label} (${g.findings.length})`;
      const list = document.createElement('ul');
      list.className = 'findings';
      list.append(...g.findings.map((f) => finding(f, g.key)));
      return [head, list];
    }));
  }

  function finding(f: Finding, severity: string): HTMLElement {
    const li = document.createElement('li');
    li.className = `finding ${severity}`;

    const head = document.createElement('p');
    head.className = 'summary';
    const check = document.createElement('span');
    check.className = 'check mono';
    check.textContent = f.check;
    head.append(check, ' ', f.summary);
    li.append(head);

    if (f.start !== undefined && f.end !== undefined && f.start !== f.end) {
      const when = document.createElement('p');
      when.className = 'muted mono when';
      when.textContent = `${isoMinute(f.start)} → ${isoMinute(f.end)}`;
      li.append(when);
    }

    if (f.detail) {
      const detail = document.createElement('p');
      detail.className = 'muted detail';
      detail.textContent = f.detail;
      li.append(detail);
    }

    /* A finding about a variable the record carries opens that variable in
       the stack, which is the whole point of the report being on the same
       page as the figures. */
    if (f.quantity && has(f.quantity)) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'btn small';
      show.textContent = `Show ${f.quantity.replace(/_/g, ' ')}`;
      show.addEventListener('click', () => {
        if (!chosen.includes(f.quantity!)) {
          chosen = [f.quantity!, ...chosen].slice(0, MAX_STACK);
          drawChips();
          drawStack();
          save();
        }
        stack.get(f.quantity!)?.root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      li.append(show);
    }
    return li;
  }

  /* ------------------------------------------------------------- state -- */

  /** Reader state lives in the query string, so a view is a link. */
  function save(): void {
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null) => {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    };
    set('vars', chosen.join(','));
    set('track', legend.variable || null);
    set('trackmap', legend.colormap);
    set('trackrange', legend.range ? legend.range.join(',') : null);
    window.history.replaceState(null, '', url);
  }

  return { load };
}

export { withBase };
