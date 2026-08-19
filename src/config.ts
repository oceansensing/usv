/** Site-wide constants. Nav hrefs are base-relative — `withBase` in
    `lib/url.ts` is what turns them into links. */

export const SITE = {
  title: 'USV',
  fullName: 'Uncrewed surface vehicles, plotted',
  description:
    'Tracks, time series and quality control for every Saildrone, Oshen and '
    + 'Chance Maritime uncrewed surface vehicle published on the NOAA PMEL '
    + 'ERDDAP — 153 deployments, 2017 to now.',
} as const;

export const NAV = [
  { label: 'Fleet', href: '/' },
  { label: 'Campaigns', href: '/campaign/' },
  { label: 'Quality', href: '/qc/' },
  { label: 'About', href: '/about/' },
] as const;

/**
 * The ERDDAP these observations come from.
 *
 * A link, not a fetch target. **PMEL sends no `Access-Control-Allow-Origin`
 * header**, so nothing in the browser can read it — the data on this site
 * was fetched by the build. See the repository's `CLAUDE.md`.
 */
export const PMEL = 'https://data.pmel.noaa.gov/pmel/erddap' as const;

export const REPO = 'https://github.com/oceansensing/usv' as const;

export const LAB = {
  name: 'C4PO',
  fullName: 'Collaboratory for Physical Oceanography',
  url: 'https://oceansensing.org/',
  gliders: 'https://oceansensing.org/gliders/',
  analysis: 'https://github.com/truedichotomy/NOAA-USV-analysis',
} as const;

/** Where the baked data lives, relative to the site base. */
export const DATA = {
  catalog: '/data/catalog.json',
  series: '/data/series',
} as const;

/** The vendors, in the order they are listed and coloured.
 *
 *  The two accents are from the campaign analysis's palette, which was
 *  checked for colour-vision deficiency: Saildrone blue `#0072B2` and Oshen
 *  vermillion `#D55E00` are two of Okabe & Ito's eight. Chance takes the
 *  bluish green from the same set rather than a shade of one of the others,
 *  so no two vendors differ only in lightness. */
export const VENDORS = [
  { key: 'saildrone', label: 'Saildrone', color: '#0072B2' },
  { key: 'oshen', label: 'Oshen', color: '#D55E00' },
  { key: 'chance', label: 'Chance Maritime', color: '#009E73' },
] as const;

export const VENDOR_COLOR: Record<string, string> = Object.fromEntries(
  VENDORS.map((v) => [v.key, v.color]),
);

/** How a severity is described and coloured. Ordered worst first. */
export const SEVERITIES = [
  { key: 'high', label: 'Unusable where it fires', short: 'high' },
  { key: 'medium', label: 'Usable with care', short: 'medium' },
  { key: 'low', label: 'Worth knowing', short: 'low' },
  { key: 'note', label: 'Metadata', short: 'note' },
] as const;
