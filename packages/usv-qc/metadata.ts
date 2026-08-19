/**
 * The checks that read the metadata rather than the measurements.
 *
 * These are `note` severity throughout: nothing here says a number is wrong,
 * only that nobody can tell from the file what the number means. That is
 * worth reporting on its own terms — a reader who downloads
 * `BARO_PRES_FILTERED_MEAN` from PMEL gets a column of values around 1002
 * with no units attached, and has to infer hPa exactly as this site does.
 *
 * Documenting the archive's metadata faults is one of the things this site
 * is for. They are all upstream and none of them is a criticism of anyone —
 * these are near-real-time products from active missions.
 */

import type { DatasetInfo, VariableInfo, Vendor } from '@c4po/erddap-pmel';
import type { Resolved } from '@c4po/usv-vars';
import { isKnownUnit, unitFault } from '@c4po/usv-vars';
import type { Finding } from './types.ts';

/**
 * Metadata faults on the columns the site actually draws.
 *
 * Only on those: an unrecognised unit on a housekeeping channel nobody plots
 * is noise, and a report that lists forty of them buries the three that
 * matter.
 */
export function columnMetadata(resolved: readonly Resolved[]): Finding[] {
  const findings: Finding[] = [];

  for (const r of resolved) {
    if (!r.quantity) continue;

    for (const fault of r.faults) {
      /* `resolve.ts` already phrased these; it is the place that knows what
         it inferred. Repeating the reasoning here would let the two drift. */
      findings.push({
        check: 'metadata',
        severity: 'note',
        quantity: r.quantity.key,
        column: r.column,
        summary: `${r.column}: ${fault}`,
      });
    }

    /* A conversion is applied and stated, never applied silently. */
    if (r.conversion.converts) {
      findings.push({
        check: 'metadata',
        severity: 'note',
        quantity: r.quantity.key,
        column: r.column,
        summary: `${r.column} is published in ${r.publishedUnits} and is drawn in `
          + `${r.conversion.units}`,
        detail: `Multiplied by ${r.conversion.factor}. Stated because a converted axis `
          + 'that does not say so is how two vehicles end up compared in different '
          + 'units — every Oshen in this archive publishes wind in knots and every '
          + 'other vehicle in m/s.',
      });
    }
  }
  return findings;
}

/**
 * The Oshen humidity declaration, which is wrong rather than absent.
 *
 * `relative_humidity_mean` declares `units = 1` and publishes percent —
 * values of 82.0, quantized to 1 %. Taken at face value that is a relative
 * humidity of 8,200 %.
 *
 * **Detected from the values, not from the declaration**, because there is
 * nothing in the metadata to detect: a dimensionless humidity and a
 * mislabelled percentage are the same string. If a record ever really did
 * publish a fraction, this would correctly stay quiet.
 */
export function humidityUnits(
  values: Float64Array, resolved: Resolved | undefined,
): Finding[] {
  if (!resolved || resolved.publishedUnits !== '1') return [];
  let max = -Infinity;
  for (const v of values) if (Number.isFinite(v) && v > max) max = v;
  if (!(max > 1.5)) return [];
  return [{
    check: 'metadata',
    severity: 'note',
    quantity: 'relative_humidity',
    column: resolved.column,
    summary: `${resolved.column} declares "units = 1" and publishes percent`,
    detail: `The largest value in the record is ${max}, so these are percentages under `
      + 'a dimensionless label; read at face value the record would be a humidity of '
      + `${(max * 100).toFixed(0)} %. Settled from the values because the metadata `
      + 'cannot settle it — a true fraction and a mislabelled percentage carry the '
      + 'same unit string. Nothing is multiplied by anything: the numbers are already '
      + 'percent, only the label is wrong.',
  }];
}

/**
 * A wind record that cannot be put on a shared axis, because nothing says how
 * high the anemometer was.
 *
 * Chance Maritime publishes no sensor height anywhere in its metadata. The
 * site falls back to a deck-height estimate to compute U₁₀, and a U₁₀ from a
 * guessed height is a guess — so it is reported on every record it applies
 * to rather than buried in a package constant.
 */
export function windHeight(
  vendor: Vendor, hasHeightColumn: boolean, hasWind: boolean,
): Finding[] {
  if (!hasWind || hasHeightColumn || vendor !== 'chance') return [];
  return [{
    check: 'metadata',
    severity: 'note',
    quantity: 'u10',
    summary: 'no anemometer height is published, so U₁₀ rests on an assumed 2.0 m',
    detail: 'A Saildrone publishes its wind measurement height per record because the '
      + "wing moves, and an Oshen's dataset carries it as an attribute. Chance "
      + 'Maritime publishes neither. The 10-m adjustment is logarithmic in the height, '
      + 'so a factor-of-two error in it is roughly 20 % in U₁₀ — which is why this is '
      + 'stated on the record rather than left in a constant nobody reads.',
  }];
}

/**
 * Global attributes a republisher needs and this dataset does not carry.
 *
 * Only two are checked, and both because **this site redistributes somebody
 * else's observations**: without a licence there is nothing saying what a
 * reader may do with them, and without an acknowledgement there is nothing
 * saying who to credit. Everything else ERDDAP wants is between PMEL and
 * their archive.
 */
export function attribution(info: DatasetInfo): Finding[] {
  const findings: Finding[] = [];
  const has = (...keys: string[]): boolean => keys.some((k) => info.attributes[k]);

  if (!has('license')) {
    findings.push({
      check: 'metadata',
      severity: 'note',
      summary: 'the dataset publishes no licence',
      detail: 'This site shows observations it did not make, and a reader taking them '
        + 'further needs to know the terms. Where the dataset does not state them, '
        + 'the page says so rather than assuming any.',
    });
  }
  if (!has('acknowledgement', 'acknowledgment', 'creator_name')) {
    findings.push({
      check: 'metadata',
      severity: 'note',
      summary: 'the dataset names nobody to credit',
      detail: 'No acknowledgement and no creator. The institution is shown instead, '
        + 'which is the best this site can do from the file.',
    });
  }
  return findings;
}

/**
 * Columns the site could not name at all.
 *
 * Reported as one finding rather than one each: a 2017-era Saildrone carries
 * a dozen housekeeping channels nothing recognises, and a dozen separate
 * notes about them would push the findings that matter off the page. They are
 * still drawn, under their own column names.
 */
export function unresolvedColumns(resolved: readonly Resolved[]): Finding[] {
  const unknown = resolved.filter((r) => !r.quantity && !r.faults.length);
  if (unknown.length < 1) return [];
  return [{
    check: 'metadata',
    severity: 'note',
    summary: `${unknown.length} column${unknown.length === 1 ? '' : 's'} this site has `
      + 'no canonical name for',
    detail: `${unknown.map((r) => r.column).slice(0, 40).join(', ')}`
      + `${unknown.length > 40 ? `, and ${unknown.length - 40} more` : ''}. `
      + 'Drawn under their own column names and included in the download. Mostly raw '
      + 'sensor counts, optode phase and instrument housekeeping — real measurements '
      + 'of something, but not of the ocean or the atmosphere, and not comparable '
      + 'between vehicles.',
    count: unknown.length,
  }];
}

/** Whether a dataset declares a variable at all. Used by the caller to
    decide which checks are even applicable. */
export function has(variables: readonly VariableInfo[], name: string): boolean {
  return variables.some((v) => v.name === name);
}

/** Every unit string in the dataset that nothing recognises, whether or not
    the column resolved. Not a finding on its own — it is what
    `check:archive` reports so a new unit in a future season is noticed. */
export function unknownUnits(variables: readonly VariableInfo[]): string[] {
  const out = new Set<string>();
  for (const v of variables) {
    if (v.units && !isKnownUnit(v.units)) out.add(v.units);
    if (v.units && unitFault(v.units)) out.add(v.units);
  }
  return [...out];
}
