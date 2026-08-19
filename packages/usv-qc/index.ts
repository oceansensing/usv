/**
 * @c4po/usv-qc — the quality information this archive does not publish.
 *
 * The 2026 hurricane fleet, every Oshen and every Chance record carry **no
 * QC column at all**; ten older Saildrone datasets carry `RH_QC`,
 * `TEMP_AIR_QC`, `WND_QC` and a `_DM` data mode, and that is the entire QC
 * content of 153 records. So every quality statement on this site is one
 * this package made, and it says so on every page it appears.
 *
 * **A finding marks the data. It never removes or alters it.** See
 * `types.ts`.
 */

export type { Check, Finding, Report, Severity } from './types.ts';
export { MAX_MARKS, SEVERITY_RANK, rank, worst } from './types.ts';

export {
  gaps, spikes, stuck, range, dropout, cadence, timeOrder, directionConvention,
  robustScale, reportingInterval, sample, humanDuration, isoTime, isoDay,
  MIN_SPIKE, PLAUSIBLE,
} from './series.ts';

export { position, silent, haversine } from './position.ts';

export {
  attribution, columnMetadata, humidityUnits, unresolvedColumns, windHeight,
  unknownUnits, has,
} from './metadata.ts';

export { run, tally, coverageNote, mergeSimultaneousDropouts } from './report.ts';
export type { RunInput } from './report.ts';
