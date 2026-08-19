/**
 * @c4po/usv-vars — one name for each thing a USV measures.
 *
 * 429 distinct column names across three vendors and four naming eras reduce
 * to the sixty-odd canonical quantities in `quantity.ts`. Nothing above this
 * package ever sees a vendor's spelling, which is the only reason a Saildrone
 * and an Oshen can share an axis.
 *
 * Runs in the browser as well as in Node: the build uses it to write the
 * series, and the pages use it to label them.
 */

export {
  QUANTITIES, BY_KEY, DEFAULT_STACK, GROUP_LABELS,
} from './quantity.ts';
export type { Quantity, Group } from './quantity.ts';

export {
  conversionFor, applyConversion, isKnownUnit, unitFault, KNOT_MS,
} from './units.ts';
export type { Conversion } from './units.ts';

export {
  resolveVariable, resolveDataset, splitStatistic, sensorOf, labelFor, humanise,
} from './resolve.ts';
export type { Resolved, ResolvedDataset, Statistic } from './resolve.ts';

export {
  u10Neutral, windStress, WIND_HEIGHT, SURFACE_DBAR,
  dewpoint, saturationVapourPressure, specificHumidity,
  seawater, referenceSalinity, anomalyApplied, UPS,
  windComponents, windSpeedDirection,
} from './derive.ts';
export type { SeawaterInput, SeawaterResult } from './derive.ts';
