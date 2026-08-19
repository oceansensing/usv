/**
 * The catalog: which of PMEL's 522 datasets are uncrewed surface vehicles,
 * and what each one is.
 *
 * PMEL publishes no field saying "this is a Saildrone" or "this belongs to
 * the 2026 hurricane campaign". Both have to be read out of the dataset id,
 * the title and the institution, and this module is the only place that
 * guessing happens. Everything downstream takes a `DatasetSummary` and never
 * parses a name again.
 *
 * **The rules are keyword-anchored rather than a lookup table**, because a
 * table has to be edited every season and the failure mode is a new mission
 * silently not appearing. `Hurricane Monitoring 2027` will classify itself.
 */

import type { DatasetSummary, Kind, Vendor } from './types.ts';
import { catalogUrl, parseIsoTime, PMEL } from './url.ts';

/* -------------------------------------------------------------- vendor -- */

/**
 * Which company built it.
 *
 * Matched on the id first — `sd1030_hurricane_2026`, `oshenPD11_…`,
 * `chanceMC29_…` are unambiguous — then on the title and institution for the
 * few whose ids are not, like `all_swfsc_2023` and `2020_arctic_nos_all`.
 */
export function vendorOf(id: string, title: string, institution: string): Vendor | undefined {
  if (/^oshen/i.test(id) || /\boshen\b/i.test(title)) return 'oshen';
  if (/^chance/i.test(id) || /chance maritime/i.test(`${title} ${institution}`)) return 'chance';
  if (/^sd[_\d]/i.test(id) || /saildrone/i.test(`${id} ${title} ${institution}`)) return 'saildrone';
  return undefined;
}

/* ------------------------------------------------------------- vehicle -- */

/**
 * The vehicle's own designator, written the way its operators write it.
 *
 * `SD-1030` rather than `sd1030` because that is what appears in a NOAA
 * mission report; `PD11`/`PC3` and `MC29` are already the operators' own
 * forms. A dataset carrying several vehicles has no single one and returns
 * the empty string rather than a plausible-looking wrong answer.
 */
export function vehicleOf(id: string, title: string): string {
  const sd = /(?:^|[^a-z])sd[_-]?(\d{3,4})/i.exec(id) ?? /saildrone\s+(\d{3,4})/i.exec(title)
    ?? /\bdrone\s+(\d{3,4})/i.exec(title);
  /* **A four-digit number after the word "Saildrone" is not always a hull
     number.** `saildrone_2019_arctic_flux` is titled "Saildrone 2019 Arctic
     Flux Data" — a multi-platform product for a season, and the match read
     the year as a vehicle called SD-2019. Every hull in this archive is
     1005–1096, so a number that reads as a year is rejected outright rather
     than range-checked against a list that would need editing when a new
     hull is built. */
  if (sd && !isYear(sd[1])) return `SD-${sd[1]}`;

  const oshen = /oshen[_-]?(P[CD]\d+)/i.exec(id) ?? /oshen\s+(P[CD]\d+)/i.exec(title);
  if (oshen) return oshen[1].toUpperCase();

  const chance = /chance[_-]?(MC\d+)/i.exec(id) ?? /\b(MC\d{2,})\b/.exec(title);
  if (chance) return chance[1].toUpperCase();

  return '';
}

/** Whether a four-digit string is plausibly a year rather than a hull. */
const isYear = (digits: string): boolean => {
  const n = Number(digits);
  return digits.length === 4 && n >= 1990 && n <= 2100;
};

/* ------------------------------------------------------------ campaign -- */

/**
 * The mission a record belongs to, as `{programme}-{year}`.
 *
 * Anchored on a keyword in the title rather than on the id, because the ids
 * disagree with themselves across eras — the 2020 Bering vehicles are bare
 * `sd1043`, the 2021 ones `sd1055_swfsc_2021` — while the titles have named
 * the programme consistently since 2017.
 */
const PROGRAMMES: Array<[RegExp, string, string]> = [
  [/hurricane/i, 'hurricane', 'Hurricane Monitoring'],
  [/\bTPOS\b/i, 'tpos', 'Tropical Pacific Observing System'],
  [/west coast survey/i, 'west-coast', 'West Coast Survey'],
  [/nantucket/i, 'nantucket', 'Nantucket Shoals Survey'],
  [/outer shelf/i, 'outer-shelf', 'Outer Shelf Survey'],
  [/hake/i, 'hake', 'Hake Survey'],
  [/pollock|bering/i, 'bering-pollock', 'Bering Sea Pollock Survey'],
  [/gulf stream|ECMWF/i, 'gulf-stream', 'Atlantic Gulf Stream'],
  [/arctic/i, 'arctic', 'Arctic'],
  [/SWFSC/i, 'swfsc', 'Southwest Fisheries Survey'],
  [/NWFSC/i, 'nwfsc', 'Northwest Fisheries Survey'],
];

/** The four-digit year the mission is named for. Read from the title where
    it has one, then the id — a deployment that ran into January is still
    part of the season it launched in, which its own name records and its
    `minTime` does not. */
export function campaignYear(id: string, title: string, start: number): string {
  const t = /\b(20\d{2})\b/.exec(title);
  if (t) return t[1];
  const i = /\b(20\d{2})\b/.exec(id);
  if (i) return i[1];
  return Number.isFinite(start) ? `${new Date(start * 1000).getUTCFullYear()}` : 'undated';
}

export function campaignOf(
  id: string, title: string, start: number,
): { slug: string; label: string } {
  const year = campaignYear(id, title, start);
  for (const [pattern, slug, label] of PROGRAMMES) {
    if (pattern.test(title) || pattern.test(id)) {
      return { slug: `${slug}-${year}`, label: `${label} ${year}` };
    }
  }
  return { slug: `other-${year}`, label: `Other ${year}` };
}

/* ---------------------------------------------------------------- kind -- */

/**
 * What kind of thing this is, and so whether the site draws it.
 *
 * The dataset's ERDDAP `class` settles the file listings. Eleven Chance
 * datasets are `EDDTableFromFileNames` — CTD casts, echosounder, CPICS
 * imagery, raw ADCP — whose columns are `url`, `name`, `size`, with no
 * observation anywhere. Drawing one produces an empty figure and no
 * explanation, so they are listed and linked instead.
 *
 * The rest is read from the name, because a collection and a single vehicle
 * are both `Trajectory` and differ only in carrying several `trajectory`
 * values.
 */
export function kindOf(
  id: string, title: string, cdmType: string, datasetClass = '',
): Kind {
  /* `class` is the ERDDAP dataset type and settles it outright:
     `EDDTableFromFileNames` publishes a directory, not a record. It is
     checked before `cdm_data_type` because it is the thing that is actually
     true — a listing declares `Other` today, but `Other` is a legitimate
     value for a real dataset that simply does not fit ERDDAP's categories,
     and one of those turning up would be silently dropped. */
  if (datasetClass === 'EDDTableFromFileNames') return 'files';
  if (cdmType === 'Other') return 'files';
  if (/_flux$/i.test(id) || /\bflux\b/i.test(title)) return 'derived';
  if (/(^|_)all(_|$)|_all$|^all_|collection/i.test(`${id} ${title}`)) return 'collection';
  return 'trajectory';
}

/**
 * A record that is a *supplement* to a vehicle's main one rather than a
 * mission in its own right: a strap-on radiometer, an ADCP, the
 * high-resolution twin of a near-real-time product.
 *
 * Kept in the catalog and offered on the vehicle it belongs to, but not
 * counted as a deployment — `sd1052_tpos_2022` and `sd1052_tpos_2022_LWR`
 * are one vehicle-season, and counting both makes every fleet total wrong.
 */
export function variantOf(id: string): string {
  const m = /_(LWR|sbe56|adcp|adcp_rawfiles|fullres|cpics_ROIs|cpics_fullframes|echosounder|ctd)$/i
    .exec(id);
  return m ? m[1].toLowerCase() : '';
}

/* ------------------------------------------------------------- listing -- */

interface CatalogRow {
  datasetID: string;
  title: string;
  institution: string;
  cdm_data_type: string;
  class: string;
  minTime: string | null;
  maxTime: string | null;
  minLongitude: number | null;
  maxLongitude: number | null;
  minLatitude: number | null;
  maxLatitude: number | null;
}

/**
 * Every USV dataset PMEL publishes.
 *
 * Runs under Node only — see the repository's `CLAUDE.md`. PMEL sends no
 * CORS header, so this cannot be called from a browser and the site reads
 * `public/data/catalog.json`, which `scripts/build-catalog.mjs` writes from
 * here.
 */
export async function listDatasets(
  base: string = PMEL,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetSummary[]> {
  const response = await fetchImpl(catalogUrl(base));
  if (!response.ok) {
    throw new Error(`catalog: ${response.status} ${response.statusText}`);
  }
  const doc = await response.json() as {
    table: { columnNames: string[]; rows: unknown[][] };
  };
  return parseCatalog(doc);
}

/** Split from the fetch so the tests can hand it a captured response. */
export function parseCatalog(
  doc: { table: { columnNames: string[]; rows: unknown[][] } },
): DatasetSummary[] {
  const index = new Map(doc.table.columnNames.map((n, i) => [n, i]));
  const get = (row: unknown[], name: string): unknown => row[index.get(name) ?? -1];

  const out: DatasetSummary[] = [];
  for (const row of doc.table.rows) {
    const r: CatalogRow = {
      datasetID: String(get(row, 'datasetID') ?? ''),
      title: String(get(row, 'title') ?? ''),
      institution: String(get(row, 'institution') ?? ''),
      cdm_data_type: String(get(row, 'cdm_data_type') ?? ''),
      class: String(get(row, 'class') ?? ''),
      minTime: (get(row, 'minTime') ?? null) as string | null,
      maxTime: (get(row, 'maxTime') ?? null) as string | null,
      minLongitude: (get(row, 'minLongitude') ?? null) as number | null,
      maxLongitude: (get(row, 'maxLongitude') ?? null) as number | null,
      minLatitude: (get(row, 'minLatitude') ?? null) as number | null,
      maxLatitude: (get(row, 'maxLatitude') ?? null) as number | null,
    };

    /* `allDatasets` carries a row for itself. Left in, it becomes a vehicle
       at the null island with a 1970 start date. */
    if (r.datasetID === 'allDatasets' || !r.datasetID) continue;

    const vendor = vendorOf(r.datasetID, r.title, r.institution);
    if (!vendor) continue;

    /* A template is a worked example of a file format, not a deployment.
       PMEL publishes one (`saildrone_asvco2_mode_template`, 1.3 days in
       2017) and it is the only dataset in the archive whose data nobody
       intends anyone to read. */
    if (/template/i.test(r.datasetID)) continue;

    const start = r.minTime ? parseIsoTime(r.minTime) : NaN;
    const end = r.maxTime ? parseIsoTime(r.maxTime) : NaN;
    const campaign = campaignOf(r.datasetID, r.title, start);

    out.push({
      id: r.datasetID,
      title: r.title,
      institution: r.institution,
      vendor,
      kind: kindOf(r.datasetID, r.title, r.cdm_data_type, r.class),
      vehicle: vehicleOf(r.datasetID, r.title),
      campaign: campaign.slug,
      campaignLabel: campaign.label,
      start,
      end,
      west: num(r.minLongitude),
      east: num(r.maxLongitude),
      south: num(r.minLatitude),
      north: num(r.maxLatitude),
    });
  }
  return out;
}

const num = (v: number | null): number => (v === null || v === undefined ? NaN : Number(v));

/**
 * Whether a record is still reporting.
 *
 * Six hours rather than a day: every active mission in this archive reports
 * at least every five minutes, so a vehicle silent for six hours is a fact
 * worth showing rather than a gap in the telemetry. `now` is a parameter so
 * the tests are not a function of when they run.
 */
export function isActive(d: DatasetSummary, now: number): boolean {
  return Number.isFinite(d.end) && now - d.end < 6 * 3600;
}
