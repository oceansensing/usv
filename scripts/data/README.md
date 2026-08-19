# `saar.bin.gz`

The TEOS-10 Absolute Salinity Anomaly atlas, as `@c4po/teos10` encodes it.
Copied verbatim from the sibling `gliders` repository, where it is served to
the browser; `check:vendored` compares the two.

**It is read by the build and never shipped.** The sibling site computes
seawater properties in the reader's tab and so has to send the atlas with the
page. This site computes them in `build-series.mjs` and bakes the results, so
the 192 KB stays here.

That matters for more than bytes. Without the atlas, Absolute Salinity is
Reference Salinity wearing SA's name, and the composition anomaly it carries
reaches 0.03 g/kg — thirty times the precision density is quoted to. Baking
it in means every record on the site gets the real SA rather than the
fallback, and the fallback is reported when a position falls outside the
atlas.
