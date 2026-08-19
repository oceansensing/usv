/**
 * The pieces both build scripts need: a file cache, a decimator, and the
 * rounding that makes the output compress.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------------------------------------------------------------- cache -- */

/**
 * A file cache keyed on the dataset, its last report time, **and the format
 * version of what is stored**.
 *
 * The first two make it correct rather than merely fast: a historic record's
 * data is immutable, so its entry stays valid, and an active mission's
 * `maxTime` advances every few minutes, so its entry invalidates itself. No
 * expiry, no staleness window, nothing to tune.
 *
 * **The third is there because what is cached is derived, and derivations
 * change.** These entries are not upstream responses — they hold quality
 * findings, canonical variable names, derived quantities, the rounding, and
 * the sentences the page prints. Keyed on the data alone, a fix to any of
 * that reaches only the records still reporting: an archived record's
 * `maxTime` never moves again, so the old file is served forever and the
 * change silently never lands. That happened — `coverageNote` was corrected
 * on 46 records, the build ran green, and all 46 came back with the old
 * sentence because none of them had reported since. `version` is the fix, and
 * bumping it is the whole ritual: **change what a built entry contains, bump
 * the version.**
 *
 * It is what keeps a rebuild short. Fetching all 153 records cold is most of
 * an hour against PMEL; with the cache warm only the active missions move,
 * and in CI `actions/cache` restores the directory between runs.
 */
export class Cache {
  constructor(dir, version) {
    if (!Number.isInteger(version) || version < 1) {
      /* Not a default, deliberately. A caller that has not thought about the
         version is a caller whose next fix will not reach its data. */
      throw new Error('Cache needs an integer format version — see its note');
    }
    this.dir = dir;
    this.version = version;
    fs.mkdirSync(dir, { recursive: true });
  }

  path(id, stamp) {
    /* Both go in the filename rather than inside the file, so a stale entry
       is simply a name nothing asks for and `prune` can find it. */
    return path.join(this.dir,
      `${id}@${String(stamp).replace(/[^0-9]/g, '')}v${this.version}.json`);
  }

  read(id, stamp) {
    const p = this.path(id, stamp);
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* A half-written entry from an interrupted build. Dropping it is right;
         reading round it is not. */
      fs.rmSync(p, { force: true });
      return undefined;
    }
  }

  write(id, stamp, value) {
    const p = this.path(id, stamp);
    /* Written to a temporary name and renamed, so an interrupted build
       cannot leave a truncated entry that the next one reads as complete. */
    const tmp = `${p}.part`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, p);
  }

  /** The stamp this cache keys a dataset by: its last report time, or
      `none` where the record has none. One definition, because three
      scripts key on it and two of them used to spell it out themselves. */
  static stamp(d) {
    return Number.isFinite(d.end) ? Math.round(d.end) : 'none';
  }

  /** Drop every entry for a dataset except the one still in use. */
  prune(keep) {
    const wanted = new Set(keep);
    let dropped = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      if (!wanted.has(path.join(this.dir, name))) {
        fs.rmSync(path.join(this.dir, name), { force: true });
        dropped++;
      }
    }
    return dropped;
  }
}

/* ------------------------------------------------------------ decimate -- */

/**
 * Thin a record to at most `cap` rows by keeping every nth **real sample**.
 *
 * Subsampling rather than averaging, deliberately. Every value on this site
 * is a number some instrument actually reported: an averaged series would
 * contain readings that were never taken, and — on a record where the QC has
 * just marked spikes at specific timestamps — those marks would no longer
 * line up with anything drawn.
 *
 * The last row is always kept. "Where is it now" is the question a fleet map
 * is opened with, and a stride that happens not to land on the final sample
 * would move every active vehicle backwards by up to `stride` rows.
 */
export function decimateIndices(rows, cap) {
  if (rows <= cap) return null;
  const stride = Math.ceil(rows / cap);
  const keep = [];
  for (let i = 0; i < rows; i += stride) keep.push(i);
  if (keep[keep.length - 1] !== rows - 1) keep.push(rows - 1);
  return keep;
}

/** Apply an index list to a column. */
export function take(values, keep) {
  if (!keep) return values;
  const out = new Float64Array(keep.length);
  for (let i = 0; i < keep.length; i++) out[i] = values[keep[i]];
  return out;
}

/* ------------------------------------------------------------- rounding -- */

/**
 * A column as JSON: rounded to the quantity's own precision, `null` for
 * missing.
 *
 * **This is the encoding decision, and it was measured.** On the largest
 * record in the archive — 16,247 rows × 18 columns — the candidates gzip to:
 *
 *     CSV as ERDDAP sent it                482,325 B
 *     Float32 columnar binary              356,283 B
 *     int16 quantized binary               258,255 B
 *     JSON, each column rounded here       315,473 B
 *
 * JSON beats Float32 because rounding to what the instrument resolves leaves
 * short repetitive tokens and gzip eats those. It needs no decode step beyond
 * `JSON.parse`, it is readable when something looks wrong, and — the part
 * that decides it — **GitHub Pages compresses `application/json` and does not
 * compress `application/octet-stream`**.
 *
 * int16 is 18 % smaller again and is not used: it makes every value wrong at
 * the last digit, needs a scale and offset per column to be read at all, and
 * buys 57 KB on the largest file in the archive.
 */
export function roundColumn(values, digits) {
  const factor = 10 ** digits;
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    /* `null` rather than `NaN`: JSON has no NaN, and `JSON.stringify` emits
       it as `null` anyway — writing it explicitly means the reader is not
       relying on that. An empty slot must never become 0, which would draw a
       line through zero where a record has a gap. */
    out[i] = Number.isFinite(v) ? Math.round(v * factor) / factor : null;
  }
  return out;
}

/** Times as whole seconds. Every record in this archive reports on a second
    boundary; the fractional part on the Saildrone `.000Z` stamps is always
    zero, and carrying it would add three characters to every row. */
export function roundTime(values) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = Number.isFinite(values[i]) ? Math.round(values[i]) : null;
  }
  return out;
}

/* ---------------------------------------------------------------- misc -- */

/** Run `worker` over `items` with at most `limit` in flight.
 *
 *  Three, matching the sibling glider client's measurement: four parallel
 *  requests to an ERDDAP measured 4.3 s against ~4.4 s of serial time,
 *  because the server queues rather than parallelises. The concurrency is
 *  here so a request is in flight while another is being parsed; raising it
 *  only lengthens the queue. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return fs.statSync(file).size;
}

export const human = (bytes) =>
  (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(0)} KB`);

/**
 * The dataset info, cached once and read by all three builds.
 *
 * `build-catalog` writes it; `build-series` and `build-detail` read it rather
 * than asking PMEL again for something that has not changed. **It is one
 * function because it used to be three** — the writer went through `Cache`
 * and each reader spelled the filename out for itself, so putting a version
 * in the key broke both readers at once and the build stopped dead. A path
 * that three scripts agree on is a path none of them should be constructing.
 */
export const INFO_FORMAT = 1;

export function infoCache() {
  return new Cache(
    fileURLToPath(new URL('../../.cache/info', import.meta.url)), INFO_FORMAT,
  );
}

/**
 * Row indices grouped by the chunk their timestamp falls in.
 *
 * Grouped rather than sliced, because a record is not guaranteed to be sorted
 * and a slice would silently drop whatever is out of order — Oshen records
 * and the 2020 Arctic Saildrones both step backwards between consecutive
 * rows.
 *
 * **A row with no timestamp cannot be placed and is not returned.** That is
 * the only correct thing to do with it — there is no week it belongs to — but
 * it means the count of rows that come out is not the count that went in, and
 * an index reporting the second promises samples the shard does not hold.
 * `oshenPC1_hurricane_2025` is 31,983 rows of which **5,493 have no time at
 * all**, so its shard held 26,490 and its index claimed 31,983. Callers
 * should take the row count from this, which is why it is returned.
 */
export function groupByChunk(time, chunkSeconds) {
  const groups = new Map();
  let placed = 0;
  for (let i = 0; i < time.length; i++) {
    const t = time[i];
    if (!Number.isFinite(t)) continue;
    const c = Math.floor(t / chunkSeconds);
    let g = groups.get(c);
    if (!g) groups.set(c, (g = []));
    g.push(i);
    placed++;
  }
  return { groups, placed, dropped: time.length - placed };
}
