/**
 * Reading `info/<id>/index.json` — what columns a dataset has, and what its
 * publisher says about them.
 *
 * The document is a table with a `Row Type` column: `variable` rows declare
 * a column, `attribute` rows attach metadata to one (or to `NC_GLOBAL`). So
 * it is read in two passes, because an attribute can precede the variable it
 * belongs to.
 */

import type { DatasetInfo, VariableInfo } from './types.ts';
import { infoUrl, parseIsoTime, PMEL } from './url.ts';

interface InfoDoc {
  table: { columnNames: string[]; rows: unknown[][] };
}

/**
 * Columns that are never a variable a reader wants drawn.
 *
 * **This list does the job `ioos_category` does on the Glider DAC**, which
 * PMEL leaves empty on everything but `Time` and `Location`. It is
 * deliberately short: a column is excluded for being an identifier, a
 * coordinate or a flag, and for nothing else. Engineering channels — pitch,
 * roll, wing angle, heading — stay plottable, because a pilot reading a
 * mission wants them and nobody else has to look at them.
 */
const IDENTIFIER = /^(trajectory|trajectoryID|drone_id|wmo_id|station|ID|source_file|name|url|fileType|lastModified|size)$/i;
const FLAG = /(_qc|_QC|_DM|_dm)$|^qartod|_flag$/;
const COORDINATE = /^(time|latitude|longitude)$/;

function isAncillary(name: string, type: string): boolean {
  if (IDENTIFIER.test(name)) return true;
  if (FLAG.test(name)) return true;
  if (COORDINATE.test(name)) return true;
  /* A String column has no numeric meaning; whatever it is, it is not a
     series. `sample_count` is a count of what was averaged, not a
     measurement of anything in the ocean. */
  if (type === 'String') return true;
  if (/^sample_count$/i.test(name)) return true;
  return false;
}

/** Parse a captured `info` document. Split from the fetch so the tests run
    against fixtures with no network. */
export function parseInfo(id: string, doc: InfoDoc): DatasetInfo {
  const index = new Map(doc.table.columnNames.map((n, i) => [n, i]));
  const col = (row: unknown[], name: string): string =>
    String(row[index.get(name) ?? -1] ?? '');

  const declared: Array<{ name: string; type: string }> = [];
  const attrs = new Map<string, Map<string, string>>();

  for (const row of doc.table.rows) {
    const rowType = col(row, 'Row Type');
    const varName = col(row, 'Variable Name');
    if (rowType === 'variable') {
      declared.push({ name: varName, type: col(row, 'Data Type') });
    } else if (rowType === 'attribute') {
      let bag = attrs.get(varName);
      if (!bag) attrs.set(varName, (bag = new Map()));
      bag.set(col(row, 'Attribute Name'), col(row, 'Value'));
    }
  }

  const global = attrs.get('NC_GLOBAL') ?? new Map<string, string>();

  const variables: VariableInfo[] = declared.map(({ name, type }) => {
    const a = attrs.get(name) ?? new Map<string, string>();
    return {
      name,
      type,
      units: a.get('units') || undefined,
      longName: a.get('long_name') || undefined,
      standardName: a.get('standard_name') || undefined,
      range: parseRange(a.get('actual_range')),
      ancillary: isAncillary(name, type),
    };
  });

  const names = new Set(declared.map((v) => v.name));

  return {
    id,
    title: global.get('title') ?? id,
    institution: global.get('institution') ?? '',
    summary: global.get('summary') ?? '',
    start: timeAttr(global, 'time_coverage_start'),
    end: timeAttr(global, 'time_coverage_end'),
    bounds: {
      west: numAttr(global, 'geospatial_lon_min'),
      east: numAttr(global, 'geospatial_lon_max'),
      south: numAttr(global, 'geospatial_lat_min'),
      north: numAttr(global, 'geospatial_lat_max'),
    },
    variables,
    cdmType: global.get('cdm_data_type') ?? '',
    timeVar: 'time',
    latVar: names.has('latitude') ? 'latitude' : 'lat',
    lonVar: names.has('longitude') ? 'longitude' : 'lon',
    attributes: Object.fromEntries(
      KEPT_GLOBALS.filter((k) => global.get(k)).map((k) => [k, global.get(k)!]),
    ),
  };
}

/**
 * The global attributes shown on the page.
 *
 * A whitelist, because the full set runs to fifty entries of ERDDAP
 * bookkeeping and the reader wants the six that say who made the data, under
 * what terms, and who to credit. **`license` and `acknowledgement` are the
 * load-bearing two** — this site republishes someone else's observations and
 * the terms travel with them.
 */
const KEPT_GLOBALS = [
  'license', 'acknowledgement', 'acknowledgment', 'creator_name', 'creator_email',
  'creator_url', 'publisher_name', 'references', 'infoUrl', 'source', 'program',
  'project', 'platform', 'sea_name', 'contributor_name', 'date_created',
] as const;

function parseRange(v: string | undefined): [number, number] | undefined {
  if (!v) return undefined;
  const parts = v.split(/[,\s]+/).map(Number).filter((n) => n === n);
  return parts.length === 2 ? [parts[0], parts[1]] : undefined;
}

function numAttr(bag: Map<string, string>, key: string): number {
  const v = Number(bag.get(key));
  return v === v ? v : NaN;
}

/** A CF time coverage attribute is an ISO string, not a number. */
function timeAttr(bag: Map<string, string>, key: string): number {
  const raw = bag.get(key);
  return raw ? parseIsoTime(raw) : NaN;
}

/** Fetch and parse. Node only — PMEL sends no CORS header. */
export async function fetchInfo(
  id: string,
  base: string = PMEL,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetInfo> {
  const response = await fetchImpl(infoUrl(base, id));
  if (!response.ok) {
    throw new Error(`info ${id}: ${response.status} ${response.statusText}`);
  }
  return parseInfo(id, await response.json() as InfoDoc);
}
