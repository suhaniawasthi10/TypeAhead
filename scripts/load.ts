/**
 * load.ts — Dataset ingestion + EAGER PRECOMPUTE (Milestone M1, rebuilt).
 *
 * Builds the two-layer store from the notes:
 *   frequency   = Search Frequency DB  (query -> count)        — source of truth
 *   suggestions = Top Suggestions DB   (prefix -> top-k)       — precomputed cache layer
 *
 * WHY eager precompute: typeahead's prefix set is small and fully knowable at load time
 * (we have all the titles), so we precompute every served prefix's top-10 ONCE. Reads
 * become O(1) key fetches — no range-scan cliff on short prefixes. (See CLAUDE.md §9.)
 *
 * FAST LOADER (fixes the old ~2.5 h per-row-UPSERT path): we never maintain an index
 * during the 35M-row ingest. Instead:
 *   1. Bulk-INSERT raw (display, n) rows into an UNINDEXED `staging` table.
 *   2. Aggregate GROUP BY in single SQL passes to build `frequency` (top N by count).
 *   3. Build `suggestions` from `frequency` in one windowed SQL pass.
 *   4. Create indexes LAST, then drop staging.
 *
 * Input : data/clickstream.tsv.gz (or .tsv), columns: prev <TAB> curr <TAB> type <TAB> n.
 * Run   : npm run load
 */
import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { openDb, DB_PATH } from "../src/db.ts";

const INPUT_PATH = process.env.CLICKSTREAM_PATH ?? "data/clickstream.tsv.gz";
const TOP_N = Number(process.env.TOP_N ?? 200_000);
const MIN_PREFIX = 3; // "start suggesting after 3 letters"
const MAX_PREFIX = 20; // can't precompute infinitely long prefixes; >20 -> range-scan fallback
const TOP_K = 10; // assignment requires top-10 (notes use 5)
const COMMIT_EVERY = 500_000; // staging insert batch size (no index -> big batches are cheap)

function secs(t0: number) {
  return ((Date.now() - t0) / 1000).toFixed(1) + "s";
}

async function main() {
  console.log(`[load] input : ${INPUT_PATH}`);
  console.log(`[load] db    : ${DB_PATH}`);
  console.log(`[load] top N : ${TOP_N}, prefixes ${MIN_PREFIX}-${MAX_PREFIX}, top-k ${TOP_K}`);

  if (!existsSync(INPUT_PATH)) {
    console.error(
      `\n[load] ❌ dump not found at "${INPUT_PATH}".\n` +
        `       Download an English Clickstream dump (clickstream-enwiki-YYYY-MM.tsv.gz)\n` +
        `       from https://dumps.wikimedia.org/other/clickstream/ and save it there.\n`
    );
    process.exit(1);
  }

  const db = openDb();
  // Bulk-load speed knobs. Safe because a crashed load is just re-run from the source file.
  db.pragma("synchronous = OFF");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -262144"); // ~256 MB page cache for the big sorts

  // Clean slate so re-running is idempotent.
  db.exec(`
    DROP TABLE IF EXISTS queries;       -- legacy table from the lazy design
    DROP TABLE IF EXISTS staging;
    DROP TABLE IF EXISTS by_display;
    DROP TABLE IF EXISTS frequency;
    DROP TABLE IF EXISTS suggestions;
    CREATE TABLE staging (display TEXT, n INTEGER);   -- NO INDEX: pure fast appends
  `);

  // ---- Step 1: stream the gzip, bulk-insert raw rows into staging --------------------
  const tStage = Date.now();
  const insert = db.prepare("INSERT INTO staging (display, n) VALUES (?, ?)");
  const rl = createInterface({
    input: INPUT_PATH.endsWith(".gz")
      ? createReadStream(INPUT_PATH).pipe(createGunzip())
      : createReadStream(INPUT_PATH),
    crlfDelay: Infinity,
  });

  let lines = 0;
  let skipped = 0;
  db.exec("BEGIN");
  for await (const line of rl) {
    const parts = line.split("\t");
    if (parts.length < 4) {
      skipped++;
      continue;
    }
    const display = parts[1]; // curr (raw; underscores cleaned later in SQL)
    const n = Number(parts[3]);
    if (!display || !Number.isFinite(n)) {
      skipped++;
      continue;
    }
    insert.run(display, n);
    if (++lines % COMMIT_EVERY === 0) {
      db.exec("COMMIT");
      db.exec("BEGIN");
      process.stdout.write(`\r[load] staged ${lines.toLocaleString()} lines…`);
    }
  }
  db.exec("COMMIT");
  console.log(
    `\n[load] step 1: staged ${lines.toLocaleString()} lines (${skipped.toLocaleString()} skipped) in ${secs(tStage)}`
  );

  // ---- Step 2: aggregate -> frequency (Search Frequency DB), keep top N --------------
  // 2a. Collapse identical (cleaned) display strings and sum their counts.
  const tFreq = Date.now();
  db.exec(`
    CREATE TABLE by_display AS
      SELECT cd AS query_display, SUM(n) AS c
      FROM (SELECT trim(replace(display, '_', ' ')) AS cd, n FROM staging)
      WHERE cd <> ''
      GROUP BY cd;
  `);
  // 2b. Merge case-variants under one lowercase key, keep the highest-count display as the
  //     representative, total the counts, and keep only the top N keys by total count.
  db.exec(`
    CREATE TABLE frequency (query_lower TEXT, query_display TEXT, count INTEGER);
    INSERT INTO frequency (query_lower, query_display, count)
      SELECT query_lower, query_display, total FROM (
        SELECT lower(query_display) AS query_lower,
               query_display,
               SUM(c)        OVER (PARTITION BY lower(query_display))                  AS total,
               ROW_NUMBER()  OVER (PARTITION BY lower(query_display) ORDER BY c DESC)  AS rn
        FROM by_display
      )
      WHERE rn = 1
      ORDER BY total DESC
      LIMIT ${TOP_N};
  `);
  const freqCount = (db.prepare("SELECT COUNT(*) c FROM frequency").get() as { c: number }).c;
  console.log(`[load] step 2: frequency = ${freqCount.toLocaleString()} rows in ${secs(tFreq)}`);

  // ---- Step 3: precompute -> suggestions (Top Suggestions DB) ------------------------
  // For each title, generate its prefixes of length MIN_PREFIX..min(len, MAX_PREFIX),
  // rank titles per prefix by count desc, keep top-k, and store as a JSON array.
  const tSugg = Date.now();
  db.exec(`
    CREATE TABLE suggestions (prefix TEXT, top_k TEXT);
    INSERT INTO suggestions (prefix, top_k)
      WITH RECURSIVE lens(k) AS (
        SELECT ${MIN_PREFIX}
        UNION ALL SELECT k + 1 FROM lens WHERE k < ${MAX_PREFIX}
      )
      SELECT prefix,
             json_group_array(json_object('query_display', query_display, 'count', count)
                              ORDER BY count DESC) AS top_k
      FROM (
        SELECT substr(f.query_lower, 1, lens.k) AS prefix,
               f.query_display,
               f.count,
               ROW_NUMBER() OVER (PARTITION BY substr(f.query_lower, 1, lens.k)
                                  ORDER BY f.count DESC) AS rn
        FROM frequency f
        JOIN lens ON lens.k <= length(f.query_lower)
      )
      WHERE rn <= ${TOP_K}
      GROUP BY prefix;
  `);
  const suggCount = (db.prepare("SELECT COUNT(*) c FROM suggestions").get() as { c: number }).c;
  console.log(`[load] step 3: suggestions = ${suggCount.toLocaleString()} prefixes in ${secs(tSugg)}`);

  // ---- Step 4: indexes LAST, then drop staging ---------------------------------------
  const tIdx = Date.now();
  db.exec(`
    CREATE UNIQUE INDEX idx_frequency_lower   ON frequency(query_lower);   -- >20 fallback range scan
    CREATE UNIQUE INDEX idx_suggestions_prefix ON suggestions(prefix);     -- O(1) key fetch
    DROP TABLE staging;
    DROP TABLE by_display;
  `);
  db.exec("VACUUM;");
  console.log(`[load] step 4: indexes + cleanup in ${secs(tIdx)}`);

  const top = db.prepare("SELECT query_display, count FROM frequency ORDER BY count DESC LIMIT 5").all();
  console.log(`[load] top 5 sample:`, top);
  db.close();
  console.log(`[load] ✅ ready — DB at ${DB_PATH}`);
}

const tAll = Date.now();
main()
  .then(() => console.log(`[load] total wall time: ${secs(tAll)}`))
  .catch((err) => {
    console.error("[load] failed:", err);
    process.exit(1);
  });
