/**
 * What a variable is called on screen, and what it should be drawn in.
 *
 * **The decisions are not made here.** `@c4po/usv-vars` resolved 429 vendor
 * column names onto canonical quantities at build time, and every label,
 * unit, colormap and floor on this site was written into the series file by
 * `build-series.mjs`. This module is the adapter: it turns that JSON into the
 * shape `figure.ts` and `track-legend.ts` expect, which is the sibling glider
 * site's `Plottable` — unchanged, so the vendored figure code needs no edits
 * and `check:vendored` can compare it byte for byte.
 *
 * Doing the naming at build time rather than here is what makes a Saildrone
 * and an Oshen share an axis: by the time anything reaches the browser, both
 * carry a column called `sea_temperature` in °C, and neither carries
 * `TEMP_SBE37_MEAN` or `sst_mean`.
 */

/** One variable of a baked series, as `build-series.mjs` wrote it. */
export interface SeriesVariable {
  key: string;
  quantity: string | null;
  column: string | null;
  label: string;
  short: string;
  units: string;
  publishedUnits: string;
  converted: boolean;
  colormap: string;
  group: string;
  rank: number;
  sensor: string;
  statistic: string;
  floor: number | null;
  note: string | null;
  derived: boolean;
}

export interface Plottable {
  /** The key the column is stored under. */
  name: string;
  label: string;
  /**
   * A compact form for the pointer readout.
   *
   * The readout sits above the plot and the axes already carry the full
   * label, so spelling "Conservative Temperature" there a second time costs
   * eighty characters — which wrap onto three lines in a half-width column
   * and move the figure out from under the pointer that summoned it.
   */
  short: string;
  units: string;
  colormap: string;
  rank: number;
  /** True for a quantity computed by the build rather than published. */
  derived: boolean;
  /** The sentence explaining what a derived or easily-misread quantity is. */
  note?: string;
  /**
   * A value the quantity physically cannot go below, where one exists.
   *
   * Used only to clamp an automatic *colour* limit — never to hide or alter
   * a sample. An optical sensor's dark counts put real readings below zero,
   * so a chlorophyll colour bar computed from the data alone starts at a
   * negative concentration and spends part of the ramp on water that cannot
   * exist.
   */
  floor?: number;
  /**
   * Whether this belongs in the chip row as a variable to plot.
   *
   * Time and position are `false`: they are the *axes* a series is drawn
   * against, and a plot of time against time is not a figure. They are still
   * offered in the axis menus, which is the whole reason they are in this
   * list.
   */
  section: boolean;
}

/** The axes a series is drawn against: offered in the menus, kept out of the
    chip row. */
const AXES = new Set(['time', 'lat', 'lon']);

const AXIS_LABELS: Record<string, { label: string; short: string; units: string }> = {
  time: { label: 'Time', short: 'time', units: '' },
  lat: { label: 'Latitude', short: 'lat', units: '°N' },
  lon: { label: 'Longitude', short: 'lon', units: '°E' },
};

/**
 * Everything the reader can put on an axis.
 *
 * Position and time come first in the list and last in the ranking, so they
 * are always available as axes and never clutter the front of a menu.
 */
export function plottable(variables: readonly SeriesVariable[]): Plottable[] {
  const out: Plottable[] = [];

  for (const [name, meta] of Object.entries(AXIS_LABELS)) {
    out.push({
      name,
      label: meta.label,
      short: meta.short,
      units: meta.units,
      /* Time takes a sequential map because it is one — a track coloured by
         it reads as a clock. Position takes a diverging map, which is what
         the sibling site uses for a signed coordinate. */
      colormap: name === 'time' ? 'cmo.thermal' : 'cmo.balance',
      rank: name === 'time' ? 950 : 980,
      derived: false,
      section: false,
    });
  }

  for (const v of variables) {
    if (AXES.has(v.key)) continue;
    out.push({
      name: v.key,
      label: v.label,
      short: v.short,
      units: v.units,
      colormap: v.colormap,
      /* Parenthesised deliberately: `+` binds tighter than `??`, so
         `v.rank + GROUP_OFFSET[g] ?? v.rank` is `(v.rank + undefined) ?? …`
         for an unrecognised group — and `??` does not catch NaN, so the
         fallback never fires and the variable sorts nowhere. */
      rank: v.rank + (GROUP_OFFSET[v.group] ?? 900),
      derived: v.derived,
      note: v.note ?? undefined,
      floor: v.floor ?? undefined,
      section: true,
    });
  }

  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

/**
 * How the groups are ordered against each other.
 *
 * A quantity's `rank` orders it within its group; this spaces the groups so
 * they do not interleave. A reader following a storm wants pressure and wind
 * at the top and the magnetometer at the bottom, and both are `rank: 10` in
 * their own group.
 */
const GROUP_OFFSET: Record<string, number> = {
  meteorology: 0,
  derived: 100,
  ocean: 200,
  waves: 300,
  radiation: 400,
  platform: 500,
};

/** The label and its units, as one string for an axis. */
export function axisLabel(v: Plottable): string {
  return v.units ? `${v.label} (${v.units})` : v.label;
}

/** The groups, in display order, with the variables that belong to each.
    Used by the vehicle page to draw one stack per group. */
export function byGroup(
  variables: readonly SeriesVariable[],
): Array<{ group: string; variables: SeriesVariable[] }> {
  const groups = new Map<string, SeriesVariable[]>();
  for (const v of variables) {
    const list = groups.get(v.group) ?? [];
    list.push(v);
    groups.set(v.group, list);
  }
  return [...groups.entries()]
    .map(([group, list]) => ({
      group,
      variables: list.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => (GROUP_OFFSET[a.group] ?? 900) - (GROUP_OFFSET[b.group] ?? 900));
}
