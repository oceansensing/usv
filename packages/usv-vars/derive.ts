/**
 * Quantities computed here rather than published.
 *
 * Four of them exist because the archive cannot be compared without them,
 * and the rest because a surface temperature and salinity are two numbers a
 * reader has to do arithmetic on before they mean anything about the water.
 *
 * ## Sea pressure is zero, and that is a decision
 *
 * Every variable named `pressure` on a USV is **atmospheric**. There is no
 * depth axis anywhere in this archive outside three ADCP datasets, so the
 * TEOS-10 quantities are evaluated at a sea pressure of **0 dbar** — the
 * surface — as a constant, not read from a column.
 *
 * The trap this closes is specific and silent: `baro_pressure_filtered` is
 * about 1013, and fed to a seawater routine as dbar it is a kilometre down.
 * Measured on a real tropical sample (SA 36.86 g/kg, 29.56 °C): in-situ
 * density comes back **4.28 kg/m³** too high, sound speed **16.7 m/s** too
 * fast, and σ₀ — which barely depends on the pressure argument — is off by
 * 0.085, eighty-five times the precision density is quoted to. Every one of
 * those numbers still looks like seawater. Nothing here reads a pressure
 * column, and the sea pressure is a named constant so that a future edit has
 * to mean it.
 *
 * The keel sensors sit at roughly 0.5 m (Saildrone) and 0.69 m (Oshen),
 * which is 0.05 dbar and below the resolution of anything computed from it.
 */

import {
  ctFromT, potentialDensity, saFromSP, soundSpeed, spiciness0,
} from '@c4po/teos10';

/** The sea pressure every TEOS-10 quantity here is evaluated at, in dbar. */
export const SURFACE_DBAR = 0;

/* ------------------------------------------------------------- the wind -- */

/** von Kármán's constant. */
const KAPPA = 0.4;

/**
 * The 10-m neutral drag coefficient used to set the roughness length.
 *
 * 1.2 × 10⁻³ is the light-to-moderate-wind value, and the roughness that
 * falls out of it is z₀ = 10 / exp(κ/√CD10N) ≈ 1.4 × 10⁻⁴ m.
 */
const CD10N = 1.2e-3;

const Z0 = 10 / Math.exp(KAPPA / Math.sqrt(CD10N));

/**
 * Wind at a measurement height, adjusted to 10 m through a neutral
 * logarithmic profile.
 *
 * **This is what makes an Oshen and a Saildrone comparable at all.** An
 * Oshen's Gill MaxiMet sits at 0.66 m and a Saildrone's anemometer at about
 * 3.4 m; the same true wind reads roughly 31 % lower on the Oshen. Put on one
 * axis unadjusted, the vehicle closer to the water looks becalmed.
 *
 * Neutral is an assumption, not a measurement — the real profile depends on
 * the air–sea temperature difference, and in a strongly stable surface layer
 * this over-corrects. It is the standard first-order adjustment and the page
 * says it is one.
 */
export function u10Neutral(u: number, z: number): number {
  if (!(u >= 0) || !(z > 0)) return NaN;
  /* A height at or below the roughness length has no logarithmic profile to
     read: log(z/z0) goes to zero and then negative, so the adjustment
     explodes and then changes sign. Neither is a wind. */
  if (z <= Z0 * 1.001) return NaN;
  return u * Math.log(10 / Z0) / Math.log(z / Z0);
}

/**
 * Bulk wind stress, τ = ρa CD U₁₀².
 *
 * The drag coefficient is Large & Pond (1981) in the capped form: constant
 * below 11 m/s, rising linearly above it.
 */
export function windStress(u10: number, rhoAir = 1.15): number {
  if (!(u10 >= 0)) return NaN;
  const cd = u10 <= 11 ? 1.2e-3 : (0.49 + 0.065 * u10) * 1e-3;
  return rhoAir * cd * u10 * u10;
}

/** The nominal wind sensor height for a vendor, where the record does not
    publish one per row. A Saildrone does publish one and it is used in
    preference; these are the fallbacks. */
export const WIND_HEIGHT: Record<string, number> = {
  /* Gill MaxiMet on the Oshen C-Star, from the dataset's own attribute. */
  oshen: 0.66,
  /* Saildrone Explorer, when `WIND_MEASUREMENT_HEIGHT_MEAN` is absent. */
  saildrone: 3.4,
  /* Chance Maritime publishes no sensor height anywhere in its metadata;
     this is the deck height of the vessel class and is a guess, which is why
     `usv-qc` raises it as a finding on every Chance record. */
  chance: 2.0,
};

/* --------------------------------------------------------------- moisture -- */

/**
 * Dewpoint from air temperature and relative humidity.
 *
 * Magnus form with the Alduchov & Eskridge (1996) coefficients, which are
 * fitted to within 0.4 % over −40 to +50 °C — the whole range this archive
 * covers, from the Arctic missions to the Caribbean.
 */
const A = 17.625;
const B = 243.04;

export function dewpoint(tAir: number, rhPercent: number): number {
  if (!Number.isFinite(tAir) || !(rhPercent > 0)) return NaN;
  /* A humidity above saturation is a wet sensor, not a supersaturated
     atmosphere. Clamped for the logarithm's sake only — the humidity series
     itself keeps whatever was reported, and `usv-qc` reports the excursion. */
  const rh = Math.min(rhPercent, 100) / 100;
  const gamma = Math.log(rh) + (A * tAir) / (B + tAir);
  return (B * gamma) / (A - gamma);
}

/** Saturation vapour pressure over water, hPa. Same Magnus form. */
export function saturationVapourPressure(tAir: number): number {
  return 6.1094 * Math.exp((A * tAir) / (B + tAir));
}

/**
 * Specific humidity, g/kg, from air temperature, relative humidity and
 * barometric pressure.
 */
export function specificHumidity(tAir: number, rhPercent: number, pHpa: number): number {
  if (!Number.isFinite(tAir) || !(rhPercent >= 0) || !(pHpa > 0)) return NaN;
  const e = (Math.min(rhPercent, 100) / 100) * saturationVapourPressure(tAir);
  /* The ratio of the molar masses of water and dry air. */
  const eps = 0.62197;
  return (1000 * eps * e) / (pHpa - (1 - eps) * e);
}

/* ------------------------------------------------------------- seawater -- */

export interface SeawaterInput {
  /** Practical salinity, dimensionless. */
  salinity: number;
  /** In-situ temperature, °C on ITS-90. */
  temperature: number;
  lon: number;
  lat: number;
}

export interface SeawaterResult {
  sa: number;
  ct: number;
  sigma0: number;
  spice0: number;
  soundSpeed: number;
}

const EMPTY: SeawaterResult = { sa: NaN, ct: NaN, sigma0: NaN, spice0: NaN, soundSpeed: NaN };

/**
 * The TEOS-10 surface set for one sample.
 *
 * The position is passed because **Absolute Salinity depends on what the
 * salt is made of**, which was measured and lives in a lookup atlas. The
 * anomaly reaches 0.03 g/kg — thirty times the precision density is quoted
 * to. Without the atlas this is Reference Salinity wearing SA's name, and
 * the caller is told which it got rather than being left to assume.
 */
export function seawater(input: SeawaterInput, atlas: unknown = null): SeawaterResult {
  const { salinity: sp, temperature: t, lon, lat } = input;
  if (!Number.isFinite(sp) || !Number.isFinite(t)) return EMPTY;

  const anomaly = (atlas ?? null) as Parameters<typeof saFromSP>[4];
  const withAnomaly = saFromSP(sp, SURFACE_DBAR, lon, lat, anomaly);
  /* `saFromSP` returns NaN outside the atlas or without a position; falling
     back to Reference Salinity is right, and pretending it was SA is not. */
  const sa = Number.isFinite(withAnomaly) ? withAnomaly : referenceSalinity(sp);

  const ct = ctFromT(sa, t, SURFACE_DBAR);
  return {
    sa,
    ct,
    sigma0: potentialDensity(sa, t, SURFACE_DBAR, 0) - 1000,
    spice0: spiciness0(sa, ct),
    soundSpeed: soundSpeed(sa, t, SURFACE_DBAR),
  };
}

/** SP on a mass basis, assuming Standard Seawater composition. The factor is
    the TEOS-10 definition of Reference Salinity, exact by convention. */
export const UPS = 35.16504 / 35;
export const referenceSalinity = (sp: number): number => UPS * sp;

/**
 * Whether the atlas was actually applied at a position.
 *
 * Reported per dataset rather than per sample: a mission stays in one basin,
 * so either the atlas covers it or it does not, and a page saying "Absolute
 * Salinity, except for 4 % of it" would be answering a question nobody
 * asked.
 */
export function anomalyApplied(sp: number, lon: number, lat: number, atlas: unknown): boolean {
  const anomaly = (atlas ?? null) as Parameters<typeof saFromSP>[4];
  return Number.isFinite(saFromSP(sp, SURFACE_DBAR, lon, lat, anomaly));
}

/* ------------------------------------------------------------ direction -- */

/**
 * Wind components from speed and the direction it blows *from*.
 *
 * The meteorological convention is the trap: a "northerly" is wind *from*
 * the north, which moves air southward, so both components carry a minus
 * sign. Getting it wrong flips the vector by 180° and every wind rose drawn
 * from it points the wrong way while looking perfectly plausible.
 */
export function windComponents(speed: number, fromDegrees: number): { u: number; v: number } {
  if (!Number.isFinite(speed) || !Number.isFinite(fromDegrees)) return { u: NaN, v: NaN };
  const rad = (fromDegrees * Math.PI) / 180;
  return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

/** Speed and from-direction from components. The inverse of the above, and
    tested against it. */
export function windSpeedDirection(u: number, v: number): { speed: number; from: number } {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return { speed: NaN, from: NaN };
  const speed = Math.hypot(u, v);
  const from = (Math.atan2(-u, -v) * 180) / Math.PI;
  return { speed, from: from < 0 ? from + 360 : from };
}
