/**
 * Vendor column name → canonical quantity.
 *
 * 429 distinct plottable column names across 153 records, four naming eras
 * and three vendors, reduce to the fifty-odd quantities in `quantity.ts`.
 * This is where.
 *
 * ## Three things are parsed off a name, not enumerated
 *
 * **The statistic.** `TEMP_AIR_MEAN` and `TEMP_AIR_STDDEV` are the same
 * quantity reported two ways, and `standard_name` says `air_temperature` for
 * both. Enumerating every product of quantity and statistic would be four
 * hundred entries; parsing the suffix is one function.
 *
 * **The sensor.** `TEMP_SBE37_MEAN`, `TEMP_CTD_RBR_MEAN`,
 * `TEMP_DEPTH_HALFMETER_MEAN` and `TEMP_O2_RBR_MEAN` all carry
 * `standard_name: sea_water_temperature`, and one of them is the oxygen
 * optode's own thermistor. A reader choosing "Temperature" from a menu of
 * four identical entries has no way to know which they picked.
 *
 * **The averaging window.** `_FILTERED_` is Saildrone's and Chance's word
 * for the same thing `_MEAN` is; it carries no separate meaning and is
 * dropped.
 *
 * ## And one thing is not parsed at all
 *
 * A `standard_name` match **never outranks an exact name match**, because
 * the metadata is not always right. `TEMP_LW_MEAN` — the longwave
 * radiometer's own body temperature, with units mis-encoded as `¡C` — is
 * published as `standard_name: air_temperature`. Counting that as canonical
 * puts the inside of an instrument on the same axis as the air.
 */

import type { VariableInfo } from '@c4po/erddap-pmel';
import { BY_KEY, type Quantity } from './quantity.ts';
import { conversionFor, type Conversion, isKnownUnit, unitFault } from './units.ts';

/** Which statistic a column reports. `mean` is the measurement itself. */
export type Statistic = 'mean' | 'stddev' | 'min' | 'max' | 'peak';

export interface Resolved {
  /** The vendor's own column name — the only place it is still correct. */
  column: string;
  /** The canonical quantity, or undefined for a column nothing recognises. */
  quantity?: Quantity;
  statistic: Statistic;
  /** Which instrument took it, where the name says: `SBE37`, `RBR`, … */
  sensor: string;
  /** How to get from the published unit to the quantity's canonical one. */
  conversion: Conversion;
  /** The unit as published, kept so the page can say what was converted. */
  publishedUnits: string;
  /** What is wrong with this column's metadata, for `usv-qc` to report. */
  faults: string[];
  /**
   * What this column is called on screen.
   *
   * Assigned by `resolveDataset`, not by `resolveVariable`, because
   * uniqueness is a property of the *set*: a label is only ambiguous next to
   * another one like it. A column resolved on its own gets a provisional
   * label that is correct but may not be unique.
   */
  label: string;
}

/* ------------------------------------------------------------ statistic -- */

const STAT_SUFFIX: Array<[RegExp, Statistic]> = [
  [/_(stddev|std|rms|sd)$/i, 'stddev'],
  [/_(peak)$/i, 'peak'],
  [/_(max|maximum)$/i, 'max'],
  [/_(min|minimum)$/i, 'min'],
  [/_(mean|avg|average)$/i, 'mean'],
];

/**
 * Strip the statistic and the averaging word off a name, leaving the part
 * that says *what was measured*.
 *
 * `WIND_SPEED_FILTERED_STDDEV` → `wind_speed`, statistic `stddev`.
 * `sbe37_temperature_filtered` → `sbe37_temperature`, statistic `mean`.
 *
 * A column with no suffix at all is the measurement: `SOG`, `HDG`, `ROLL`
 * and `TEMP_AIR` are all bare in one era or another.
 */
export function splitStatistic(name: string): { stem: string; statistic: Statistic } {
  let stem = name;
  let statistic: Statistic = 'mean';
  for (const [pattern, kind] of STAT_SUFFIX) {
    if (pattern.test(stem)) {
      stem = stem.replace(pattern, '');
      statistic = kind;
      break;
    }
  }
  /* `_FILTERED_` is the vendors' word for "averaged over the reporting
     interval" and means exactly what `_MEAN` does. Dropped after the
     statistic, so `_FILTERED_STDDEV` keeps its stddev. */
  stem = stem.replace(/_?filtered_?/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return { stem: stem.toLowerCase(), statistic };
}

/* --------------------------------------------------------------- sensor -- */

/**
 * The instrument, where the column name names one.
 *
 * Worth extracting rather than ignoring: an archive record can carry four
 * sea temperatures, and "which sensor" is the difference between the CTD on
 * the keel and the thermistor inside the oxygen optode.
 */
/**
 * **`\b` is the wrong boundary for these names, and it fails silently.**
 * An underscore is a word character, so `/\bsbe37\b/` does not match inside
 * `TEMP_SBE37_MEAN` — there is no boundary between `_` and `S`. The first
 * draft used it, every Saildrone CTD came back with no sensor at all, and
 * the sensor ranking below then fell through to a tie that the stable sort
 * happened to resolve correctly. It would have stopped doing that the first
 * time a dataset listed its columns in another order.
 *
 * `T` matches a token boundary in a `SCREAMING_SNAKE` or `snake_case`
 * identifier: the start, the end, or any character that is not a letter or
 * a digit.
 */
const T = '(?:^|[^a-z0-9])';
const t = '(?:[^a-z0-9]|$)';
const token = (word: string): RegExp => new RegExp(`${T}${word}${t}`, 'i');

const SENSORS: Array<[RegExp, string]> = [
  [token('sbe37'), 'SBE37'],
  [token('sbe56'), 'SBE56'],
  [token('rbr'), 'RBR'],
  [token('aanderaa'), 'Aanderaa'],
  [token('wetlabs'), 'WETLabs'],
  [token('fluoro'), 'WETLabs'],
  [token('airmar'), 'Airmar'],
  [token('sonic'), 'sonic'],
  [token('halfmeter'), '0.5 m'],
  /* `ir` on its own is two letters that turn up inside words, so it is
     matched only as a whole token — `TEMP_IR_MEAN`, `ir_thermo_…` — and
     never as a substring. */
  [token('ir'), 'infrared'],
  [token('ir_thermo'), 'infrared'],
];

export function sensorOf(name: string): string {
  for (const [pattern, label] of SENSORS) if (pattern.test(name)) return label;
  return '';
}

/* ------------------------------------------------------------- the map -- */

/**
 * Exact stems, checked first and winning over everything.
 *
 * Written against the stem — after the statistic and `_FILTERED_` have gone
 * — so one entry covers `WIND_SPEED_MEAN`, `WIND_SPEED_STDDEV`,
 * `WIND_SPEED_FILTERED_MEAN` and bare `WIND_SPEED`.
 */
const BY_STEM: Record<string, string> = {
  /* -- wind ------------------------------------------------------------ */
  wind_speed: 'wind_speed',
  wind_speed_world: 'wind_speed',
  wind_speed_motion_corrected: 'wind_speed',
  wind_speed_platform: 'wind_speed',
  wind_speed_corr: 'wind_speed',
  wind_speed_airmar: 'wind_speed',
  wind_airmar_wind_speed: 'wind_speed',
  wind_sound_velocity: 'wind_speed',
  gust_wnd: 'wind_gust',
  wind_gust: 'wind_gust',
  wind_speed_max_motion_corrected: 'wind_gust',
  /* Oshen's 2025 era spells its gust as the CF standard name itself. Eight
     datasets, and without this entry their only gust column resolves to
     nothing. */
  wind_speed_of_gust: 'wind_gust',
  wind_speed_mean_motion_corrected: 'wind_speed',
  wind_from: 'wind_direction',
  wind_dir: 'wind_direction',
  wind_dir_deg: 'wind_direction',
  wind_dir_corr_deg: 'wind_direction',
  wind_direction: 'wind_direction',
  wind_direction_corr: 'wind_direction',
  wind_direction_airmar: 'wind_direction',
  wind_airmar_wind_direction: 'wind_direction',
  wind_direction_world: 'wind_direction',
  wind_from_direction: 'wind_direction',
  wind_from_direction_motion_corrected: 'wind_direction',
  uwnd: 'wind_east',
  uwnd_corr: 'wind_east',
  uwnd_platform: 'wind_east',
  wind_speed_world_e: 'wind_east',
  vwnd: 'wind_north',
  vwnd_corr: 'wind_north',
  vwnd_platform: 'wind_north',
  wind_speed_world_n: 'wind_north',
  wwnd: 'wind_vertical',
  wwnd_corr: 'wind_vertical',
  wwnd_platform: 'wind_vertical',
  wind_speed_world_d: 'wind_vertical',
  wind_measurement_height: 'wind_height',
  sonic_temperature: 'sonic_temperature',
  wind_sonic_temp: 'sonic_temperature',
  speed_of_sound: 'sound_speed_air',

  /* -- other meteorology ----------------------------------------------- */
  temp_air: 'air_temperature',
  air_temperature: 'air_temperature',
  baro_pres: 'air_pressure',
  baro_pressure: 'air_pressure',
  air_pressure: 'air_pressure',
  rh: 'relative_humidity',
  rh_adjusted: 'relative_humidity',
  asvco2_rh: 'relative_humidity',
  relative_humidity: 'relative_humidity',

  /* -- ocean ------------------------------------------------------------ */
  temp_sbe37: 'sea_temperature',
  temp_ctd: 'sea_temperature',
  temp_ctd_rbr: 'sea_temperature',
  temp_depth_halfmeter: 'sea_temperature',
  temp_sea: 'sea_temperature',
  sbe37_temperature: 'sea_temperature',
  rbr_coda_t_temperature: 'sea_temperature',
  sst: 'sea_temperature',
  sea_surface_temperature: 'sea_temperature',
  temp_o2: 'sea_temperature',
  temp_o2_rbr: 'sea_temperature',
  temp_o2_aanderaa: 'sea_temperature',
  temp_ir: 'skin_temperature',
  temp_ir_uncomp: 'skin_temperature',
  temp_ir_uncor: 'skin_temperature',
  temp_ir_sea_wing_uncomp: 'skin_temperature',
  ir_thermo_temperature: 'skin_temperature',
  sal: 'salinity',
  sal_sbe37: 'salinity',
  sal_rbr: 'salinity',
  sbe37_practical_salinity: 'salinity',
  cond: 'conductivity',
  cond_sbe37: 'conductivity',
  cond_rbr: 'conductivity',
  sbe37_conductivity: 'conductivity',
  conductivity: 'conductivity',
  o2_conc: 'oxygen_concentration',
  o2_conc_sbe37: 'oxygen_concentration',
  o2_conc_rbr: 'oxygen_concentration',
  o2_rbr_conc: 'oxygen_concentration',
  o2_conc_uncor: 'oxygen_concentration',
  o2_conc_aanderaa: 'oxygen_concentration',
  o2_aanderaa_conc_uncor: 'oxygen_concentration',
  sbe37_o2_concentration: 'oxygen_concentration',
  o2_sat: 'oxygen_saturation',
  o2_sat_sbe37: 'oxygen_saturation',
  o2_sat_rbr: 'oxygen_saturation',
  o2_rbr_sat: 'oxygen_saturation',
  o2_sat_aanderaa: 'oxygen_saturation',
  o2_aanderaa_sat: 'oxygen_saturation',
  sbe37_o2_saturation: 'oxygen_saturation',
  chlor: 'chlorophyll',
  chlor_wetlabs: 'chlorophyll',
  chlor_rbr: 'chlorophyll',
  fluoro_chlorophyll: 'chlorophyll',
  cdom: 'cdom',
  bkfluor_red: 'backscatter',
  bksct_red: 'backscatter',
  water_current_speed: 'current_speed',
  water_current_direction: 'current_direction',
  u: 'current_east',
  v: 'current_north',

  /* -- waves ------------------------------------------------------------ */
  wave_significant_height: 'wave_height',
  wave_dominant_period: 'wave_period_dominant',
  wave_mean_period: 'wave_period_mean',

  /* -- radiation -------------------------------------------------------- */
  par_air: 'par',
  par_radiation: 'par',
  sw_irrad_total: 'shortwave_down',
  sw_unmasked_irrad_center: 'shortwave_down',
  sw_unmasked_irrad_6det: 'shortwave_down',
  sw_irrad_diffuse: 'shortwave_diffuse',
  lw_irrad: 'longwave_down',
  lw_net_irrad: 'longwave_net',

  /* -- platform --------------------------------------------------------- */
  sog: 'speed_over_ground',
  speed_over_ground: 'speed_over_ground',
  cog: 'course_over_ground',
  course_over_ground: 'course_over_ground',
  hdg: 'heading',
  yaw_minute: 'heading',
  pitch: 'pitch',
  roll: 'roll',
  wing_angle: 'wing_angle',
  hdg_wing: 'wing_heading',
  wing_hdg: 'wing_heading',
  wing_yaw: 'wing_heading',
  wing_pitch: 'wing_pitch',
  wing_roll: 'wing_roll',
  heave: 'heave',
  delayed_heave: 'heave',
  heave_rate: 'heave_rate',
  altitude: 'altitude',
  vel_n: 'velocity_north',
  vel_e: 'velocity_east',
  vel_d: 'velocity_down',
  batt_vpower: 'battery_voltage',
  depth: 'depth',
  dt800_depth: 'depth',
  qs: 'sensible_heat_flux',
  ql: 'latent_heat_flux',
  tau: 'wind_stress',
  acc_x: 'acceleration_x',
  acc_y: 'acceleration_y',
  acc_z: 'acceleration_z',
  accel_x: 'acceleration_x',
  accel_y: 'acceleration_y',
  accel_z: 'acceleration_z',
  gyro_x: 'rotation_x',
  gyro_y: 'rotation_y',
  gyro_z: 'rotation_z',
  mag_strength: 'magnetic_strength',
  mag_x: 'magnetic_x',
  mag_y: 'magnetic_y',
  mag_z: 'magnetic_z',
};

/**
 * `standard_name` → quantity, for the long tail.
 *
 * Consulted **after** the stem table, never before. The archive fills
 * `standard_name` in well and it is what makes a name nobody anticipated
 * resolve at all — but it is also what is wrong on `TEMP_LW_MEAN`, so it
 * cannot be allowed to override a name this file knows.
 */
const BY_STANDARD: Record<string, string> = {
  air_temperature: 'air_temperature',
  air_pressure: 'air_pressure',
  relative_humidity: 'relative_humidity',
  wind_speed: 'wind_speed',
  wind_speed_of_gust: 'wind_gust',
  wind_from_direction: 'wind_direction',
  eastward_wind: 'wind_east',
  northward_wind: 'wind_north',
  downward_air_velocity: 'wind_vertical',
  sea_water_temperature: 'sea_temperature',
  sea_surface_temperature: 'sea_temperature',
  sea_surface_skin_temperature: 'skin_temperature',
  sea_water_practical_salinity: 'salinity',
  sea_water_electrical_conductivity: 'conductivity',
  mole_concentration_of_dissolved_molecular_oxygen_in_sea_water: 'oxygen_concentration',
  fractional_saturation_of_oxygen_in_sea_water: 'oxygen_saturation',
  mass_concentration_of_chlorophyll_in_sea_water: 'chlorophyll',
  concentration_of_chlorophyll_in_sea_water: 'chlorophyll',
  concentration_of_colored_dissolved_organic_matter_in_sea_water_expressed_as_equivalent_mass_fraction_of_quinine_sulfate_dihydrate:
    'cdom',
  sea_surface_wave_significant_height: 'wave_height',
  sea_surface_wave_period_at_variance_spectral_density_maximum: 'wave_period_dominant',
  sea_surface_wave_mean_period: 'wave_period_mean',
  surface_downwelling_photosynthetic_photon_flux_in_air: 'par',
  surface_downwelling_shortwave_flux_in_air: 'shortwave_down',
  diffuse_downwelling_shortwave_flux_in_air: 'shortwave_diffuse',
  surface_downwelling_longwave_flux_in_air: 'longwave_down',
  platform_speed_wrt_ground: 'speed_over_ground',
  platform_course: 'course_over_ground',
  platform_yaw_angle: 'heading',
  platform_pitch_angle: 'pitch',
  platform_roll_angle: 'roll',
  magnitude_of_magnetic_field: 'magnetic_strength',
  altitude: 'altitude',
  eastward_sea_water_velocity: 'current_east',
  northward_sea_water_velocity: 'current_north',
};

/**
 * Columns that must never resolve, whatever their `standard_name` says.
 *
 * `TEMP_LW_MEAN` is the longwave radiometer's own body temperature and is
 * published as `standard_name: air_temperature`. On the two LWR datasets
 * that carry it, it would have appeared beside the real air temperature
 * under the same label, differing by several degrees, with nothing to say
 * which was the atmosphere.
 *
 * Kept as a named exclusion rather than a pattern: it is one column, the
 * reason is specific to it, and a pattern broad enough to catch it would
 * catch things that are fine.
 */
const NEVER: Record<string, string> = {
  temp_lw: "the longwave radiometer's own body temperature, published as "
    + 'standard_name: air_temperature',
};

/* ------------------------------------------------------------- resolve -- */

/** Resolve one column. */
export function resolveVariable(v: VariableInfo): Resolved {
  const { stem, statistic } = splitStatistic(v.name);
  const faults: string[] = [];

  const conversion = conversionFor(v.units);
  const damage = unitFault(v.units);
  if (damage) faults.push(damage);

  const excluded = NEVER[stem];
  if (excluded) {
    return {
      column: v.name,
      statistic,
      sensor: sensorOf(v.name),
      conversion,
      publishedUnits: v.units ?? '',
      faults: [...faults, `not plotted: ${excluded}`],
      label: humanise(v.name),
    };
  }

  const key = BY_STEM[stem]
    ?? (v.standardName ? BY_STANDARD[v.standardName] : undefined);
  const quantity = key ? BY_KEY.get(key) : undefined;

  if (quantity) {
    if (!v.units) {
      /* Chance publishes no units at all on pressure, chlorophyll and the
         wind components. The quantity says what they must be; that is an
         inference, and the page says so. */
      faults.push(`no units published; read as ${quantity.units} from the quantity`);
    } else if (!isKnownUnit(v.units)) {
      faults.push(`the unit "${v.units}" is not one this site knows how to convert`);
    }
  }

  return {
    column: v.name,
    quantity,
    statistic,
    sensor: sensorOf(v.name),
    /* With no published unit, the values are taken to be in the canonical
       one already — which is what they are, on every Chance column checked.
       Guessing a *conversion* would be a different and much worse thing than
       guessing a label. */
    conversion: v.units ? conversion : { factor: 1, offset: 0, units: quantity?.units ?? '', converts: false },
    publishedUnits: v.units ?? '',
    faults,
    label: quantity ? quantity.label : humanise(v.name),
  };
}

/**
 * Resolve a whole dataset, and decide which column *is* each quantity.
 *
 * A record can carry four sea temperatures — the SBE37 on the keel, an RBR,
 * a half-metre thermistor and the oxygen optode's internal one — all with
 * `standard_name: sea_water_temperature`. The site needs one of them to be
 * "the" sea temperature and the rest to be available and clearly labelled.
 *
 * The primary is the `mean` statistic on the highest-ranked sensor. The
 * ranking is the instruments' own: a pumped SBE37 is the reference CTD, an
 * RBR CODA beside it is a check, and a thermistor inside a different
 * instrument's housing is not a sea temperature measurement at all — it is
 * last, and it is never primary while anything else exists.
 */
const SENSOR_RANK: Record<string, number> = {
  SBE37: 0, RBR: 1, SBE56: 2, '0.5 m': 3, Aanderaa: 4, WETLabs: 0, Airmar: 5,
  infrared: 0, sonic: 5, '': 2,
};

/** A column whose stem says it is another instrument's housekeeping
    temperature rather than a measurement of the sea. */
const HOUSEKEEPING = /^temp_o2/;

export interface ResolvedDataset {
  /** Every column, resolved. Order preserved from the dataset. */
  columns: Resolved[];
  /** Quantity key → the column that is the primary measurement of it. */
  primary: Map<string, Resolved>;
  /** Quantity key → every column that measures it, primary first. */
  byQuantity: Map<string, Resolved[]>;
}

export function resolveDataset(variables: readonly VariableInfo[]): ResolvedDataset {
  const columns = variables.filter((v) => !v.ancillary).map(resolveVariable);
  const byQuantity = new Map<string, Resolved[]>();

  for (const r of columns) {
    if (!r.quantity || r.statistic !== 'mean') continue;
    const group = byQuantity.get(r.quantity.key) ?? [];
    group.push(r);
    byQuantity.set(r.quantity.key, group);
  }

  const primary = new Map<string, Resolved>();
  for (const [key, group] of byQuantity) {
    group.sort((a, b) => score(a) - score(b));
    primary.set(key, group[0]);
  }

  /* Names are settled over the whole set, because ambiguity is a property of
     the set. A 2021-era record carries `TEMP_CTD_RBR_MEAN` *and*
     `TEMP_O2_RBR_MEAN` — two different instruments, both RBR — so naming
     them by sensor alone produces two entries reading "Sea water temperature
     (RBR)". That is the same failure as two bare "Temperature" chips, one
     step further along, and only a pass that can see both catches it. */
  for (const r of columns) {
    r.label = r.quantity
      ? labelFor(r, primary.get(r.quantity.key) === r)
      : humanise(r.column);
  }
  const seen = new Map<string, Resolved[]>();
  for (const r of columns) {
    const peers = seen.get(r.label) ?? [];
    peers.push(r);
    seen.set(r.label, peers);
  }
  for (const peers of seen.values()) {
    if (peers.length < 2) continue;
    /* The column name is the one thing about a column that is unique and
       that the file itself chose, so it is what breaks the tie. The primary
       keeps its plain label: it is the one a reader means. */
    for (const r of peers) {
      if (r.quantity && primary.get(r.quantity.key) === r) continue;
      r.label = `${r.quantity?.label ?? humanise(r.column)} (${r.column})`;
    }
  }

  return { columns, primary, byQuantity };
}

function score(r: Resolved): number {
  const housekeeping = HOUSEKEEPING.test(splitStatistic(r.column).stem) ? 100 : 0;
  return housekeeping + (SENSOR_RANK[r.sensor] ?? 3);
}

/**
 * A label for a column that is not the primary measurement of its quantity.
 *
 * "Sea water temperature (RBR)" rather than a second "Sea water
 * temperature", because two identical entries in a menu is the failure this
 * whole sensor business exists to prevent.
 */
export function labelFor(r: Resolved, isPrimary: boolean): string {
  if (!r.quantity) return humanise(r.column);
  const parts = [r.quantity.label];
  if (!isPrimary && r.sensor) parts.push(`(${r.sensor})`);
  else if (!isPrimary) parts.push(`(${humanise(r.column)})`);
  if (r.statistic !== 'mean') parts.push(`— ${STAT_LABEL[r.statistic]}`);
  return parts.join(' ');
}

const STAT_LABEL: Record<Statistic, string> = {
  mean: 'mean',
  stddev: 'standard deviation',
  min: 'minimum',
  max: 'maximum',
  peak: 'peak',
};

/** Title-case a column name as a last resort. Better than showing the raw
    identifier, and honest about being a fallback because it keeps the words
    the file used. */
export function humanise(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
