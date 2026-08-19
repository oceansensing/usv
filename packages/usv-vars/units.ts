/**
 * Units: what the archive says, what it means, and what it takes to compare
 * two vehicles on one axis.
 *
 * Fifty distinct unit strings appear across the 153 records for what reduce
 * to about twenty actual units. Most of the variation is spelling —
 * `m s-1`, `m_per_sec`; `mS cm-1`, `milliS cm-1`, `mS_per_cm`, `mS/cm`. Some
 * of it is not.
 *
 * ## The three that are wrong rather than merely spelled differently
 *
 * **Oshen wind is in knots.** Every other vehicle publishes m/s. Put on one
 * axis unconverted, an Oshen appears to be in roughly twice the wind a
 * Saildrone beside it is in.
 *
 * **Oshen relative humidity declares `units = 1` and publishes percent** —
 * values of 82.0, quantized to 1 %. Read at face value that is a humidity of
 * 8,200 %. There is no way to tell a dimensionless fraction from a mislabeled
 * percentage from the metadata alone, so it is settled by the values, and
 * `usv-qc` reports the fault rather than this file fixing it quietly.
 *
 * **`TEMP_LW_MEAN` on the two LWR datasets carries `¡C`** — U+00A1, an
 * inverted exclamation mark. That is `°C` written as Mac Roman (where 0xA1
 * is the degree sign) and read back as Latin-1. Harmless once recognised,
 * and a good marker for metadata nobody has checked.
 *
 * ## The rule
 *
 * **A conversion is applied and stated; it is never applied silently.**
 * Every series records the unit it arrived in as well as the one it is
 * drawn in, the page prints both, and the conversions here are exact —
 * multiply and offset, no fitting, no clipping. The alternative is a fleet
 * axis carrying two units, which is not a figure but a mistake waiting to
 * be read off.
 */

/** A conversion from a published unit to this site's canonical one. */
export interface Conversion {
  /** `canonical = published * factor + offset`. */
  factor: number;
  offset: number;
  /** The unit after conversion. */
  units: string;
  /** True when this is a real change of scale rather than a respelling, and
      so something the page has to say out loud. */
  converts: boolean;
}

const KNOT_MS = 0.514444;

/**
 * How a published unit string is normalised, and converted where it must be.
 *
 * Keyed by the string exactly as PMEL publishes it, lower-cased and with
 * runs of whitespace collapsed. Anything absent is passed through unchanged
 * rather than guessed at — an unrecognised unit is a fact about the archive
 * worth surfacing, and inventing a conversion for it would be worse than
 * printing it as it came.
 */
const TABLE: Record<string, Conversion> = {};

const same = (from: string[], units: string): void => {
  for (const f of from) TABLE[f] = { factor: 1, offset: 0, units, converts: false };
};
const scale = (from: string[], units: string, factor: number, offset = 0): void => {
  for (const f of from) TABLE[f] = { factor, offset, units, converts: true };
};

/* Temperature. `¡C` is `°C` mis-decoded; `degree_t` is a true bearing and
   belongs with the angles, not here. */
same(['degree_c', 'degrees_c', 'degc', 'degree_celsius', 'celsius', '¡c', '°c'], '°C');

/* Speed. The knot conversion is the one that matters — it is every Oshen's
   wind in this archive. */
same(['m s-1', 'm_per_sec', 'm/s', 'ms-1'], 'm/s');
scale(['knot', 'knots', 'kt'], 'm/s', KNOT_MS);
scale(['cm s-1', 'cm/s'], 'm/s', 0.01);

/* Angles. `radians` is Chance's Airmar wind direction and nothing else. */
same(['degree', 'degrees', 'deg', 'degree_t', 'degrees_true', '°'], '°');
scale(['radian', 'radians', 'rad'], '°', 180 / Math.PI);

/* Pressure. */
same(['hpa', 'mbar', 'millibar'], 'hPa');
scale(['kpa'], 'hPa', 10);
scale(['pa'], 'hPa', 0.01);

/* Conductivity. */
same(['ms cm-1', 'millis cm-1', 'ms_per_cm', 'ms/cm'], 'mS/cm');
scale(['s m-1', 's/m'], 'mS/cm', 10);

/* Concentrations. */
same(['micromol l-1', 'micromoles/liter', 'umol l-1', 'umol/l', 'µmol/l'], 'µmol/L');
same(['microgram l-1', 'ugpl', 'ug l-1', 'ug/l', 'mg m-3'], 'µg/L');
same(['micromol s-1 m-2', 'umol_s-1_m-2', 'umol m-2 s-1'], 'µmol/m²/s');
same(['ppb'], 'ppb');
same(['(m sr)-1', 'm-1 sr-1'], 'm⁻¹ sr⁻¹');

/* Fluxes and the rest. */
same(['w m-2', 'w/m2', 'w m^-2'], 'W/m²');
same(['n/m2', 'n m-2'], 'N/m²');
same(['percent', '%'], '%');
same(['m', 'meters', 'metre', 'metres'], 'm');
same(['km'], 'km');
same(['s', 'seconds', 'sec'], 's');
same(['m s-2', 'm/s2'], 'm/s²');
same(['rad s-1', 'rad/s'], 'rad/s');
same(['microtesla', 'ut', 'µt'], 'µT');
same(['volts', 'volt', 'v'], 'V');
same(['mv'], 'mV');
same(['count', 'counts'], '');

/* Salinity is dimensionless and the archive says so four different ways.
   Printed as nothing, because "35.2 PSU" and "35.2 1" are both worse than
   "35.2" under an axis already labelled Practical salinity. */
same(['psu', 'pss-78', 'pss78', '1', ''], '');

/** Normalise a published unit string for lookup. */
function key(units: string | undefined): string {
  return (units ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * How to get from a published unit to the canonical one.
 *
 * Returns a pass-through for anything unrecognised, marked `converts:
 * false`, so an unknown unit reaches the page as its own string rather than
 * as a wrong number.
 */
export function conversionFor(units: string | undefined): Conversion {
  const hit = TABLE[key(units)];
  if (hit) return hit;
  /* A CF time unit is an epoch definition — "seconds since 1970-01-01" —
     which is true, machine-readable, and absurd under an axis whose ticks
     already read as dates. */
  const k = key(units);
  if (/\bsince\b/.test(k) || k === 'utc') {
    return { factor: 1, offset: 0, units: '', converts: false };
  }
  return { factor: 1, offset: 0, units: (units ?? '').trim(), converts: false };
}

/** Whether a unit string is one this file recognises at all. `usv-qc`
    reports the ones that are not, because an unrecognised unit on a
    quantity the site draws means a number nobody has checked the scale of. */
export function isKnownUnit(units: string | undefined): boolean {
  const k = key(units);
  return k in TABLE || /\bsince\b/.test(k) || k === 'utc';
}

/**
 * Unit metadata that is damaged rather than absent.
 *
 * Returned as a reason string, or the empty string when nothing is wrong.
 * Kept here beside the table it is about; `usv-qc` turns it into a finding.
 */
export function unitFault(units: string | undefined): string {
  if (units === undefined || units === '') return '';
  /* U+00A1 is the degree sign in Mac Roman, so the archive's "¡C" is
     "°C" written there and read back as Latin-1 — which is exactly what
     `TEMP_LW_MEAN` carries on the two LWR datasets.
   *
   * Detected as "a non-ASCII character that is not one a unit legitimately
   * contains", rather than by listing the damaged forms: which mojibake a
   * wrong codec produces depends on the codec, while the legitimate set is
   * short and closed. Writing it the other way round — matching the damage
   * — is how `m s-1` ends up flagged for its hyphen. */
  for (const ch of units) {
    if (ch.charCodeAt(0) > 126 && !LEGITIMATE.has(ch)) {
      return `the unit string "${units}" contains ${codePoint(ch)}, which `
        + 'looks like text decoded with the wrong character set';
    }
  }
  return '';
}

/** The non-ASCII characters a unit may legitimately contain. */
const LEGITIMATE = new Set([...'\u00B0\u00B5\u00B2\u00B3\u207B\u00B9\u00B7\u2212\u00C5\u03A9\u2030']);

const codePoint = (ch: string): string =>
  `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/** Apply a conversion to a column, in place. Returns the same array so a
    caller can chain; `factor === 1 && offset === 0` short-circuits, because
    most columns need nothing and touching 325,000 values to multiply them
    by one is not free. */
export function applyConversion(values: Float64Array, c: Conversion): Float64Array {
  if (c.factor === 1 && c.offset === 0) return values;
  for (let i = 0; i < values.length; i++) values[i] = values[i] * c.factor + c.offset;
  return values;
}

export { KNOT_MS };
