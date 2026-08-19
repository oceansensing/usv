/**
 * What a finding is.
 *
 * ## The one rule
 *
 * **A finding marks the data. It never removes or alters it.**
 *
 * Every check here reports; none of them writes to a series. A spike that
 * has been found is still drawn, still exported, and still counted in the
 * record's statistics — it is drawn with a mark beside it saying what was
 * noticed. The reader decides.
 *
 * That is not squeamishness. This archive publishes **no QC flags at all**
 * on the 2026 hurricane fleet, on any Oshen and on any Chance record, so
 * every quality statement on this site is one the site made up. Silently
 * deleting somebody else's observations on the strength of a heuristic
 * written here would be the worst thing this package could do.
 */

export type Severity =
  /** The measurement is unusable where this fires: a dead sensor, a value
      that cannot be a measurement of anything. */
  | 'high'
  /** Usable with care, and quantitative work needs to handle it: a spike
      artifact, a long gap, a stuck reading. */
  | 'medium'
  /** Worth knowing and rarely worth acting on: a short gap, a cadence
      change, a value at the edge of plausibility. */
  | 'low'
  /** Not about the measurements: metadata that is missing, wrong or
      damaged. */
  | 'note';

export const SEVERITY_RANK: Record<Severity, number> = {
  high: 0, medium: 1, low: 2, note: 3,
};

/** The checks, named. Used as a stable key in the URL and the report. */
export type Check =
  | 'gap' | 'spike' | 'stuck' | 'range' | 'dropout' | 'cadence'
  | 'position' | 'metadata' | 'silent' | 'timeorder';

export interface Finding {
  check: Check;
  severity: Severity;
  /** The canonical quantity this is about, where it is about one. */
  quantity?: string;
  /** The vendor's own column name, so a reader can find it on PMEL. */
  column?: string;
  /** One line, written for a person. Says what was seen, not what to do. */
  summary: string;
  /** The reasoning, the numbers, and what it does not prove. */
  detail?: string;
  /** When, in epoch seconds. A point event sets both to the same value. */
  start?: number;
  end?: number;
  /** How many samples or events this covers. */
  count?: number;
  /**
   * The individual event times, for drawing on the series it belongs to.
   *
   * Capped — a record with nine thousand spikes needs a count and a mark
   * every so often, not nine thousand marks and a JSON file larger than the
   * data. `MAX_MARKS` is the cap and `count` is always the true total.
   */
  marks?: number[];
}

/** How many event times a finding carries for drawing. Beyond this the
    count is still exact and the marks are a sample. */
export const MAX_MARKS = 500;

/** Everything found in one record, plus what the checks were able to see. */
export interface Report {
  findings: Finding[];
  /**
   * The sampling interval the checks actually ran at, in seconds.
   *
   * **Stated because it bounds what could have been found.** A one-minute
   * pressure spike cannot be seen in a record fetched at five minutes, and a
   * page that does not say which it looked at implies it looked at
   * everything. The long archive records are checked at 5 minutes; anything
   * under about 100 days is checked at its native rate.
   */
  resolutionSeconds: number;
  /**
   * The vehicle's own reporting interval, for comparison with the above.
   *
   * Probed from the record before anything was decimated. **This is the
   * comparison that says what could have been found** — the spacing of the
   * rows the checks were handed equals `resolutionSeconds` whenever the fetch
   * was decimated, so comparing against that answers itself.
   */
  cadenceSeconds: number;
  /** The spacing of the rows the checks actually ran over. Equal to
      `resolutionSeconds` on a decimated fetch; recorded so a reader can see
      both numbers rather than infer one. */
  sampledCadenceSeconds: number;
  /** Rows the checks ran over. */
  rows: number;
  /** Epoch seconds the record was fetched. */
  fetched: number;
}

/** The worst severity present, for a badge. `undefined` when nothing was
    found — which is a real answer and is shown as one. */
export function worst(findings: readonly Finding[]): Severity | undefined {
  let out: Severity | undefined;
  for (const f of findings) {
    if (!out || SEVERITY_RANK[f.severity] < SEVERITY_RANK[out]) out = f.severity;
  }
  return out;
}

/** Most severe first, then earliest. A stable order matters: the report is
    written to a file that is diffed between builds, and an unstable sort
    would show every dataset as changed every night. */
export function rank(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (a.start ?? 0) - (b.start ?? 0)
    || a.check.localeCompare(b.check)
    || (a.column ?? '').localeCompare(b.column ?? ''));
}
