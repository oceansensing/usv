/**
 * The canonical quantities — what a USV measures, named once.
 *
 * Every vendor and every era publishes these under a different column name:
 * air temperature is `TEMP_AIR_MEAN`, `air_temperature_mean`,
 * `air_temperature_filtered`, `TEMP_AIR_FILTERED_MEAN` and `TEMP_AIR`
 * depending on who built the vehicle and what year it flew. **This file is
 * the only place any of them means anything**, and `resolve.ts` is the only
 * place the mapping happens.
 *
 * The colormaps are cmocean's, matched to the field the way that library
 * intends. A series drawn in viridis is readable; drawn in the map its field
 * is conventionally read in, it is comparable with every other figure the
 * reader has seen. **The `cmo.` prefix is load-bearing** — `sample()` falls
 * back to viridis for a name it does not know rather than throwing, so a
 * bare `'thermal'` produces a perfectly good plot in entirely the wrong
 * colours and nothing says so.
 *
 * Only eleven cmocean maps ship in `@c4po/plot`, and the first draft of this
 * table named five that do not: `cmo.phase`, `cmo.amp`, `cmo.tempo`,
 * `cmo.oxy`, `cmo.topo`. Every one of them would have drawn perfectly, in
 * viridis, silently. `test:vars` now checks every name here against the
 * shipped table, which is the only thing that catches it.
 *
 * A **direction takes `hsv`** rather than a sequential map, and that is not
 * decoration: a bearing wraps, so 359° and 1° must come out nearly the same
 * colour. Every sequential map puts them at opposite ends of the ramp and
 * draws a discontinuity across due north that is not in the data.
 */

/** What part of the page a quantity belongs to. The vehicle page draws one
    stack of series per group, because a reader following a storm wants the
    meteorology together and does not want it interleaved with pitch. */
export type Group = 'meteorology' | 'ocean' | 'waves' | 'radiation' | 'platform' | 'derived';

export interface Quantity {
  /** The canonical key. Stable; it appears in URLs. */
  key: string;
  label: string;
  /** Compact form for a pointer readout, where the axis already carries the
      full label. Kept short deliberately — see `Plottable.short`. */
  short: string;
  /** The unit every column resolving to this quantity is converted into. */
  units: string;
  colormap: string;
  group: Group;
  /** Sort key within the group; lower comes first. */
  rank: number;
  /**
   * A value this quantity physically cannot go below, where one exists.
   *
   * Used only to clamp an automatic *colour* limit — never to hide or alter
   * a sample. An optical sensor's dark counts put real readings below zero,
   * so a chlorophyll bar computed from percentiles alone starts at a
   * negative concentration, spending part of the ramp on water that cannot
   * exist.
   *
   * Absent where the quantity really is signed: air and sea temperature
   * reach below zero, the wind components and the vertical velocity are
   * signed by construction, and a floor on any of them would be a lie about
   * the ocean rather than a defence against a sensor.
   */
  floor?: number;
  /** A ceiling, for the few quantities that have one: a direction wraps at
      360, a saturation and a humidity are percentages. Same rule — colour
      limits only. */
  ceiling?: number;
  /** True for a compass bearing, which must not be averaged or interpolated
      the way a scalar is: the mean of 359° and 1° is 180°, which points the
      opposite way. Decimation picks real samples rather than averaging, so
      this is a flag for the QC and the readout rather than for the plot. */
  circular?: boolean;
  /** One sentence, shown beside the figure, for a quantity whose name does
      not say what it is. */
  note?: string;
}

const Q = (q: Quantity): Quantity => q;

/**
 * The table. Ordered by group and then by how often a reader wants it.
 *
 * Fifty-odd entries covers the whole archive: 429 distinct plottable column
 * names across 153 datasets reduce to these, plus the statistic suffix
 * (`_STDDEV`, `_MAX`, `_MIN`, `_PEAK`) and the sensor that took them, both
 * of which `resolve.ts` parses off rather than enumerating.
 */
export const QUANTITIES: readonly Quantity[] = [
  /* ------------------------------------------------------ meteorology -- */
  Q({ key: 'wind_speed', label: 'Wind speed', short: 'U', units: 'm/s',
    colormap: 'cmo.speed', group: 'meteorology', rank: 10, floor: 0 }),
  Q({ key: 'u10', label: 'Wind speed at 10 m (neutral)', short: 'U₁₀', units: 'm/s',
    colormap: 'cmo.speed', group: 'derived', rank: 11, floor: 0,
    note: 'Adjusted to 10 m through a neutral logarithmic profile from the '
      + "sensor's own height — 0.66 m on an Oshen, about 3.4 m on a Saildrone. "
      + 'Without it the two cannot be compared: the Oshen adjustment is +31 %.' }),
  Q({ key: 'wind_gust', label: 'Wind gust', short: 'Ugust', units: 'm/s',
    colormap: 'cmo.speed', group: 'meteorology', rank: 12, floor: 0 }),
  Q({ key: 'wind_direction', label: 'Wind from direction', short: 'θw', units: '°',
    colormap: 'hsv', group: 'meteorology', rank: 13, floor: 0, ceiling: 360,
    circular: true }),
  Q({ key: 'air_pressure', label: 'Air pressure', short: 'P', units: 'hPa',
    colormap: 'cmo.dense', group: 'meteorology', rank: 20 }),
  Q({ key: 'air_temperature', label: 'Air temperature', short: 'Ta', units: '°C',
    colormap: 'cmo.thermal', group: 'meteorology', rank: 30 }),
  Q({ key: 'relative_humidity', label: 'Relative humidity', short: 'RH', units: '%',
    colormap: 'cmo.haline', group: 'meteorology', rank: 40, floor: 0, ceiling: 100 }),
  Q({ key: 'wind_east', label: 'Eastward wind', short: 'u', units: 'm/s',
    colormap: 'cmo.balance', group: 'meteorology', rank: 50 }),
  Q({ key: 'wind_north', label: 'Northward wind', short: 'v', units: 'm/s',
    colormap: 'cmo.balance', group: 'meteorology', rank: 51 }),
  Q({ key: 'wind_vertical', label: 'Vertical wind', short: 'w', units: 'm/s',
    colormap: 'cmo.balance', group: 'meteorology', rank: 52 }),
  Q({ key: 'wind_height', label: 'Wind sensor height', short: 'zw', units: 'm',
    colormap: 'cmo.deep', group: 'meteorology', rank: 60, floor: 0,
    note: 'The height the anemometer actually sat at, which a Saildrone '
      + 'publishes per record because the wing moves.' }),
  Q({ key: 'sonic_temperature', label: 'Sonic temperature', short: 'Ts', units: '°C',
    colormap: 'cmo.thermal', group: 'meteorology', rank: 61 }),

  /* ------------------------------------------------------------ ocean -- */
  Q({ key: 'sea_temperature', label: 'Sea water temperature', short: 'T', units: '°C',
    colormap: 'cmo.thermal', group: 'ocean', rank: 10 }),
  Q({ key: 'skin_temperature', label: 'Sea surface skin temperature', short: 'Tskin',
    units: '°C', colormap: 'cmo.thermal', group: 'ocean', rank: 11,
    note: 'Measured by an infrared thermometer looking at the surface itself, '
      + 'so it responds to insolation and rain in minutes where the keel '
      + 'sensor does not.' }),
  Q({ key: 'salinity', label: 'Practical salinity', short: 'SP', units: '',
    colormap: 'cmo.haline', group: 'ocean', rank: 20, floor: 0 }),
  Q({ key: 'conductivity', label: 'Conductivity', short: 'C', units: 'mS/cm',
    colormap: 'cmo.haline', group: 'ocean', rank: 21, floor: 0 }),
  Q({ key: 'oxygen_concentration', label: 'Dissolved oxygen', short: 'O₂',
    units: 'µmol/L', colormap: 'cmo.deep', group: 'ocean', rank: 30, floor: 0 }),
  Q({ key: 'oxygen_saturation', label: 'Oxygen saturation', short: 'O₂sat', units: '%',
    colormap: 'cmo.deep', group: 'ocean', rank: 31, floor: 0 }),
  Q({ key: 'chlorophyll', label: 'Chlorophyll', short: 'chl', units: 'µg/L',
    colormap: 'cmo.algae', group: 'ocean', rank: 40, floor: 0 }),
  Q({ key: 'cdom', label: 'CDOM', short: 'CDOM', units: 'ppb',
    colormap: 'cmo.matter', group: 'ocean', rank: 41, floor: 0 }),
  Q({ key: 'backscatter', label: 'Optical backscatter', short: 'bb',
    units: 'm⁻¹ sr⁻¹', colormap: 'cmo.turbid', group: 'ocean', rank: 42, floor: 0 }),
  Q({ key: 'current_east', label: 'Eastward current', short: 'ucur', units: 'm/s',
    colormap: 'cmo.balance', group: 'ocean', rank: 50 }),
  Q({ key: 'current_north', label: 'Northward current', short: 'vcur', units: 'm/s',
    colormap: 'cmo.balance', group: 'ocean', rank: 51 }),
  Q({ key: 'current_speed', label: 'Current speed', short: 'Ucur', units: 'm/s',
    colormap: 'cmo.speed', group: 'ocean', rank: 52, floor: 0 }),
  Q({ key: 'current_direction', label: 'Current direction', short: 'θcur', units: '°',
    colormap: 'hsv', group: 'ocean', rank: 53, floor: 0, ceiling: 360,
    circular: true }),

  /* ------------------------------------------------------------ waves -- */
  Q({ key: 'wave_height', label: 'Significant wave height', short: 'Hs', units: 'm',
    colormap: 'cmo.matter', group: 'waves', rank: 10, floor: 0 }),
  Q({ key: 'wave_period_dominant', label: 'Dominant wave period', short: 'Tp',
    units: 's', colormap: 'cmo.speed', group: 'waves', rank: 11, floor: 0 }),
  Q({ key: 'wave_period_mean', label: 'Mean wave period', short: 'Tm', units: 's',
    colormap: 'cmo.speed', group: 'waves', rank: 12, floor: 0 }),

  /* -------------------------------------------------------- radiation -- */
  Q({ key: 'par', label: 'Photosynthetically active radiation', short: 'PAR',
    units: 'µmol/m²/s', colormap: 'plasma', group: 'radiation', rank: 10, floor: 0 }),
  Q({ key: 'shortwave_down', label: 'Downwelling shortwave', short: 'SW',
    units: 'W/m²', colormap: 'plasma', group: 'radiation', rank: 20, floor: 0 }),
  Q({ key: 'shortwave_diffuse', label: 'Diffuse shortwave', short: 'SWdif',
    units: 'W/m²', colormap: 'plasma', group: 'radiation', rank: 21, floor: 0 }),
  Q({ key: 'longwave_down', label: 'Downwelling longwave', short: 'LW',
    units: 'W/m²', colormap: 'inferno', group: 'radiation', rank: 22, floor: 0 }),
  Q({ key: 'longwave_net', label: 'Net longwave', short: 'LWnet', units: 'W/m²',
    colormap: 'cmo.balance', group: 'radiation', rank: 23 }),

  /* --------------------------------------------------------- platform -- */
  Q({ key: 'battery_voltage', label: 'Battery voltage', short: 'Vbatt', units: 'V',
    colormap: 'cmo.speed', group: 'platform', rank: 5, floor: 0 }),
  Q({ key: 'sound_speed_air', label: 'Speed of sound in air', short: 'cair',
    units: 'm/s', colormap: 'cmo.speed', group: 'platform', rank: 6, floor: 0,
    note: 'Reported by the sonic anemometer; it is what that instrument '
      + 'measures wind from, not an ocean property.' }),
  Q({ key: 'depth', label: 'Depth', short: 'z', units: 'm',
    colormap: 'cmo.deep', group: 'platform', rank: 7, floor: 0,
    note: 'Only the three ADCP datasets carry one — every other record on '
      + 'this site is a surface measurement with no vertical axis at all.' }),
  Q({ key: 'speed_over_ground', label: 'Speed over ground', short: 'SOG',
    units: 'm/s', colormap: 'cmo.speed', group: 'platform', rank: 10, floor: 0 }),
  Q({ key: 'course_over_ground', label: 'Course over ground', short: 'COG',
    units: '°', colormap: 'hsv', group: 'platform', rank: 11, floor: 0,
    ceiling: 360, circular: true }),
  Q({ key: 'heading', label: 'Heading', short: 'HDG', units: '°',
    colormap: 'hsv', group: 'platform', rank: 12, floor: 0, ceiling: 360,
    circular: true }),
  Q({ key: 'pitch', label: 'Pitch', short: 'pitch', units: '°',
    colormap: 'cmo.balance', group: 'platform', rank: 20 }),
  Q({ key: 'roll', label: 'Roll', short: 'roll', units: '°',
    colormap: 'cmo.balance', group: 'platform', rank: 21 }),
  Q({ key: 'wing_angle', label: 'Wing angle', short: 'wing', units: '°',
    colormap: 'cmo.balance', group: 'platform', rank: 30 }),
  Q({ key: 'wing_heading', label: 'Wing heading', short: 'wingHDG', units: '°',
    colormap: 'hsv', group: 'platform', rank: 31, circular: true }),
  Q({ key: 'wing_pitch', label: 'Wing pitch', short: 'wingP', units: '°',
    colormap: 'cmo.balance', group: 'platform', rank: 32 }),
  Q({ key: 'wing_roll', label: 'Wing roll', short: 'wingR', units: '°',
    colormap: 'cmo.balance', group: 'platform', rank: 33 }),
  Q({ key: 'heave', label: 'Heave', short: 'heave', units: 'm',
    colormap: 'cmo.balance', group: 'platform', rank: 40 }),
  Q({ key: 'heave_rate', label: 'Heave rate', short: 'dheave', units: 'm/s',
    colormap: 'cmo.balance', group: 'platform', rank: 41 }),
  Q({ key: 'altitude', label: 'Altitude', short: 'alt', units: 'm',
    colormap: 'cmo.deep', group: 'platform', rank: 50 }),
  Q({ key: 'velocity_north', label: 'Platform velocity, north', short: 'Vn',
    units: 'm/s', colormap: 'cmo.balance', group: 'platform', rank: 60 }),
  Q({ key: 'velocity_east', label: 'Platform velocity, east', short: 'Ve',
    units: 'm/s', colormap: 'cmo.balance', group: 'platform', rank: 61 }),
  Q({ key: 'velocity_down', label: 'Platform velocity, down', short: 'Vd',
    units: 'm/s', colormap: 'cmo.balance', group: 'platform', rank: 62 }),
  Q({ key: 'acceleration_x', label: 'Acceleration, x', short: 'ax', units: 'm/s²',
    colormap: 'cmo.balance', group: 'platform', rank: 70 }),
  Q({ key: 'acceleration_y', label: 'Acceleration, y', short: 'ay', units: 'm/s²',
    colormap: 'cmo.balance', group: 'platform', rank: 71 }),
  Q({ key: 'acceleration_z', label: 'Acceleration, z', short: 'az', units: 'm/s²',
    colormap: 'cmo.balance', group: 'platform', rank: 72 }),
  Q({ key: 'rotation_x', label: 'Rotation rate, x', short: 'gx', units: 'rad/s',
    colormap: 'cmo.balance', group: 'platform', rank: 73 }),
  Q({ key: 'rotation_y', label: 'Rotation rate, y', short: 'gy', units: 'rad/s',
    colormap: 'cmo.balance', group: 'platform', rank: 74 }),
  Q({ key: 'rotation_z', label: 'Rotation rate, z', short: 'gz', units: 'rad/s',
    colormap: 'cmo.balance', group: 'platform', rank: 75 }),
  Q({ key: 'magnetic_strength', label: 'Magnetic field strength', short: '|B|',
    units: 'µT', colormap: 'cmo.dense', group: 'platform', rank: 80, floor: 0 }),
  Q({ key: 'magnetic_x', label: 'Magnetic field, x', short: 'Bx', units: 'µT',
    colormap: 'cmo.balance', group: 'platform', rank: 81 }),
  Q({ key: 'magnetic_y', label: 'Magnetic field, y', short: 'By', units: 'µT',
    colormap: 'cmo.balance', group: 'platform', rank: 82 }),
  Q({ key: 'magnetic_z', label: 'Magnetic field, z', short: 'Bz', units: 'µT',
    colormap: 'cmo.balance', group: 'platform', rank: 83 }),

  /* ---------------------------------------------------------- derived -- */
  /* The three Arctic flux datasets publish these as their whole content:
     QS, QL and TAU, computed by PMEL rather than here. They land in the
     derived group because that is what they are, with a note saying whose
     arithmetic it was. */
  Q({ key: 'sensible_heat_flux', label: 'Sensible heat flux', short: 'QS',
    units: 'W/m²', colormap: 'cmo.balance', group: 'derived', rank: 20,
    note: "Published by PMEL as part of the Arctic flux products, not computed here." }),
  Q({ key: 'latent_heat_flux', label: 'Latent heat flux', short: 'QL',
    units: 'W/m²', colormap: 'cmo.balance', group: 'derived', rank: 21,
    note: "Published by PMEL as part of the Arctic flux products, not computed here." }),
  Q({ key: 'wind_stress', label: 'Wind stress', short: 'τ', units: 'N/m²',
    colormap: 'cmo.speed', group: 'derived', rank: 12, floor: 0,
    note: 'ρa CD U₁₀², with the Large & Pond (1981) drag coefficient: '
      + '1.2 × 10⁻³ below 11 m/s and (0.49 + 0.065 U₁₀) × 10⁻³ above it.' }),
  Q({ key: 'dewpoint', label: 'Dewpoint temperature', short: 'Td', units: '°C',
    colormap: 'cmo.thermal', group: 'derived', rank: 30,
    note: 'From air temperature and relative humidity through the Magnus '
      + 'form with the Alduchov & Eskridge (1996) coefficients.' }),
  Q({ key: 'specific_humidity', label: 'Specific humidity', short: 'q',
    units: 'g/kg', colormap: 'cmo.haline', group: 'derived', rank: 31, floor: 0 }),
  Q({ key: 'sa', label: 'Absolute Salinity', short: 'SA', units: 'g/kg',
    colormap: 'cmo.haline', group: 'derived', rank: 40, floor: 0,
    note: 'TEOS-10, at the surface. Without the lookup atlas this is '
      + 'Reference Salinity; the page says which it had.' }),
  Q({ key: 'ct', label: 'Conservative Temperature', short: 'Θ', units: '°C',
    colormap: 'cmo.thermal', group: 'derived', rank: 41 }),
  Q({ key: 'sigma0', label: 'Potential density anomaly σ₀', short: 'σ₀',
    units: 'kg/m³', colormap: 'cmo.dense', group: 'derived', rank: 42 }),
  Q({ key: 'spice0', label: 'Spiciness π₀', short: 'π₀', units: 'kg/m³',
    colormap: 'cmo.balance', group: 'derived', rank: 43 }),
  Q({ key: 'sound_speed', label: 'Sound speed', short: 'c', units: 'm/s',
    colormap: 'cmo.speed', group: 'derived', rank: 44, floor: 0 }),
];

/** Keyed, for the lookups `resolve.ts` and the pages do. */
export const BY_KEY: ReadonlyMap<string, Quantity> = new Map(
  QUANTITIES.map((q) => [q.key, q]),
);

/** The quantities a reader is most likely to want on screen first, in order.
    Used as the vehicle page's default stack when the URL names none — a
    reader arriving at a hurricane mission wants pressure and wind before
    magnetometer axes. */
export const DEFAULT_STACK = [
  'air_pressure', 'wind_speed', 'sea_temperature', 'air_temperature',
  'salinity', 'wave_height',
] as const;

export const GROUP_LABELS: Record<Group, string> = {
  meteorology: 'Meteorology',
  ocean: 'Ocean',
  waves: 'Waves',
  radiation: 'Radiation',
  platform: 'Platform',
  derived: 'Derived here',
};
