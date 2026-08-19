/** The shapes this package hands out. Nothing here knows about the DOM. */

/** Which company built the vehicle. Not cosmetic: it decides the unit
    conventions, the sensor heights and which QC checks are meaningful. */
export type Vendor = 'saildrone' | 'oshen' | 'chance';

/**
 * What kind of thing a dataset is.
 *
 * `trajectory` is a vehicle record and the only kind this site plots.
 * The rest are listed and linked rather than drawn, because pretending a
 * file listing is a time series produces an empty figure and no explanation.
 */
export type Kind =
  /** One vehicle, one deployment: `cdm_data_type: Trajectory` or `Point`. */
  | 'trajectory'
  /** Several vehicles in one table, separated by `trajectory` or `drone_id`. */
  | 'collection'
  /** A derived product — the Arctic flux datasets' QS/QL/TAU. */
  | 'derived'
  /** `EDDTableFromFileNames`: url/name/size rows, no observations. */
  | 'files';

/** One dataset, as the catalog lists it. Times are epoch seconds. */
export interface DatasetSummary {
  id: string;
  title: string;
  institution: string;
  vendor: Vendor;
  kind: Kind;
  /** The vehicle's own identifier — `SD-1030`, `PD11`, `MC29`. Empty when
      the record carries more than one. */
  vehicle: string;
  /**
   * True for a record whose rows come from several vehicles interleaved.
   *
   * **Its track is not a track.** Three Saildrones surveying one area report
   * in turn, so consecutive rows step between vehicles a few kilometres
   * apart and the path drawn through them is a scribble no vehicle sailed.
   * The measurements are real and are still drawn; the map is not.
   *
   * Detected as "a record that names no vehicle", because a per-vehicle
   * dataset always names its own — `sd1030_hurricane_2026` in the id,
   * `Saildrone 1030` in the title. A speed test does not work: the vehicles
   * are in the same survey box, so the implied speed between interleaved
   * fixes stays under what any of them could actually do.
   */
  multiVehicle: boolean;
  /** The mission this belongs to, as a slug: `hurricane-2026`, `tpos-2021`. */
  campaign: string;
  /** The campaign written for a person to read. */
  campaignLabel: string;
  /** Epoch seconds. `NaN` where the dataset publishes no time range. */
  start: number;
  end: number;
  west: number;
  east: number;
  south: number;
  north: number;
}

/** One column of a dataset, as `info/<id>/index.json` describes it. */
export interface VariableInfo {
  name: string;
  /** ERDDAP's own type name: double, float, int, String, … */
  type: string;
  units?: string;
  longName?: string;
  standardName?: string;
  /** `actual_range`, where the dataset publishes one. */
  range?: [number, number];
  /**
   * True for a column that is an identifier, a timestamp or a flag — never
   * something a reader wants drawn as a variable.
   *
   * Derived here rather than read from `ioos_category`, which the Glider DAC
   * fills in and **PMEL does not**: across all 165 USV datasets only `Time`
   * and `Location` ever appear. Every other classification on this site is
   * made by `usv-vars` from the name, the standard name and the units.
   */
  ancillary: boolean;
}

export interface DatasetInfo {
  id: string;
  title: string;
  institution: string;
  summary: string;
  /** Epoch seconds. */
  start: number;
  end: number;
  bounds: { west: number; east: number; south: number; north: number };
  variables: VariableInfo[];
  /** `Trajectory`, `Point`, `TimeSeries`, `Other`. */
  cdmType: string;
  timeVar: string;
  latVar: string;
  lonVar: string;
  /** Global attributes worth showing, kept raw — licence, acknowledgement,
      creator, references. Shown rather than interpreted. */
  attributes: Record<string, string>;
}

/** A rectangular block of numbers. Every column is the same length. */
export interface TableData {
  rows: number;
  /**
   * Column name → values, keyed by the **vendor's** own column name. This is
   * the one place vendor spellings are correct; `usv-vars` renames on the
   * way out and nothing downstream sees them again.
   *
   * Everything is Float64 with NaN for missing, including columns that were
   * strings on the wire, so one container serves the whole pipeline.
   */
  columns: Map<string, Float64Array>;
  /** Epoch seconds, always present and always named `time` here. */
  time: Float64Array;
  /** What was asked of the server, so a caption can say what is on screen. */
  resolution: Resolution;
  /** True when a window returned nothing readable and the rest was kept. */
  partial: boolean;
}

/** How much of the record a fetch asked for. */
export interface Resolution {
  /** `full` when no `orderByClosest` was applied. */
  kind: 'full' | 'decimated';
  /** The rung of `LADDER` used, in minutes, when `kind` is 'decimated'. */
  minutes?: number;
}
