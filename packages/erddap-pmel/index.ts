/**
 * @c4po/erddap-pmel — reading uncrewed surface vehicle records off the NOAA
 * PMEL ERDDAP.
 *
 * **Node only.** PMEL sends no `Access-Control-Allow-Origin` header on any
 * response, so nothing here can run in a browser; the site reads the JSON
 * this package's callers write. The types are shared with the browser code,
 * which is why they live here.
 *
 * See `CLAUDE.md` for what was measured against the live server, including
 * the two findings that shaped the module: `orderByClosest` saves bytes and
 * not server time, and its interval must be a multiple of five minutes.
 */

export { PMEL, isoTime, parseIsoTime, intervalString } from './url.ts';
export {
  tabledapUrl, infoUrl, catalogUrl, datasetPageUrl, datasetInfoPageUrl,
} from './url.ts';
export type { QueryOptions } from './url.ts';

export { parseJsonlCsv, parseJsonlCsvStream } from './parse.ts';
export type { ParseOptions, ParseResult } from './parse.ts';

export {
  listDatasets, parseCatalog, isActive,
  vendorOf, vehicleOf, campaignOf, campaignYear, kindOf, variantOf,
} from './catalog.ts';

export { fetchInfo, parseInfo } from './info.ts';

export {
  fetchTable, chooseRung, isFullRate, medianCadence, ErddapError,
  LADDER, FETCH_ROWS, DISPLAY_POINTS,
} from './fetch.ts';
export type { FetchOptions } from './fetch.ts';

export type {
  Vendor, Kind, DatasetSummary, VariableInfo, DatasetInfo, TableData, Resolution,
} from './types.ts';
