/**
 * Where a record's full-resolution data lives, and how it is cut up.
 *
 * The site itself is one repository serving `oceansensing.org/usv/`. The
 * full-rate data is far too large to sit beside it — 794 MB against GitHub
 * Pages' 1 GB published-site limit, which applies whatever the repository's
 * visibility — so it lives in **one repository per season**, each served as
 * its own Pages project site.
 *
 * ## They are the same origin, and that is the point
 *
 * `oceansensing/gliders` and `oceansensing/usv` already serve at
 * `oceansensing.org/gliders/` and `oceansensing.org/usv/`. A project site
 * under an organisation whose Pages custom domain is set serves under that
 * domain, so `oceansensing/usv-data-2026` serves at
 * `oceansensing.org/usv-data-2026/` — **the same origin as the site**.
 *
 * Which means the whole detail tier costs no CORS, no cross-origin
 * dependency, and no widening of `connect-src 'self'`. The policy that
 * exists because PMEL will not do CORS keeps its full strictness.
 *
 * ## Why a season
 *
 * Because **a closed season is immutable**. Once 2024 ended its data cannot
 * change, so its shard is built once and never rebuilt or re-uploaded; only
 * the current season's shard churns. Sharding by year turns "rebuild the
 * archive" into "rebuild this season", permanently.
 *
 * The busiest season on record is 2021 at 194 MB — five times under the
 * limit. A season would need roughly a hundred long-duration vehicles before
 * it needed splitting further, so `shardFor` returning a vendor-qualified
 * name is the change to make *then* and not now. It is one function so that
 * change is local.
 */

/** The season a record belongs to, as its campaign already records it. A
    deployment that ran into January belongs to the season it launched in. */
export function seasonOf(campaign: string): string {
  const m = /(\d{4})$/.exec(campaign);
  return m ? m[1] : 'undated';
}

/**
 * The repository holding a record's full-rate chunks.
 *
 * Returns the bare repository name; the site turns it into a path. Should a
 * season ever outgrow a repository, this is where it gains a vendor term —
 * `usv-data-2026-saildrone` — and nothing else has to know.
 */
export function shardFor(campaign: string): string {
  return `usv-data-${seasonOf(campaign)}`;
}

/**
 * How long one chunk covers, in seconds.
 *
 * Seven days. Measured on a real month of 1-minute data — 44,401 rows × 41
 * columns — a week is about **460 KB gzipped**, which is one unremarkable
 * request for a reader who has windowed into a storm passage. A day would be
 * 65 KB and thirteen thousand files across the archive; a month would be
 * 2 MB, most of it unwanted.
 */
export const CHUNK_SECONDS = 7 * 86400;

/**
 * Which chunk a timestamp falls in.
 *
 * Counted from the Unix epoch rather than from the record's own start, so a
 * chunk boundary is the same instant for every record and does not move when
 * a mission's first row changes. A record that gains earlier data keeps
 * every chunk it already had.
 */
export function chunkOf(epochSeconds: number): number {
  return Math.floor(epochSeconds / CHUNK_SECONDS);
}

/** The half-open span a chunk covers: `[from, to)`. */
export function chunkSpan(chunk: number): { from: number; to: number } {
  return { from: chunk * CHUNK_SECONDS, to: (chunk + 1) * CHUNK_SECONDS };
}

/**
 * Every chunk touching `[from, to]`, in order.
 *
 * Inclusive of both ends, because a reader's window is a closed interval and
 * the sample at its last instant is one they asked for.
 */
export function chunksFor(from: number, to: number): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const first = chunkOf(from);
  const last = chunkOf(to);
  const out: number[] = [];
  for (let c = first; c <= last; c++) out.push(c);
  return out;
}

/** Where one chunk is served from, relative to the site's own base. A
    sibling project site under the same domain, hence the `../`. */
export function chunkPath(shard: string, id: string, chunk: number): string {
  return `../${shard}/${encodeURIComponent(id)}/${chunk}.json.gz`;
}
