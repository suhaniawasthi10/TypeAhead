/**
 * batch-demo.ts — drives the M6 batch-write demo against a running server (port 3001):
 *   - sends a realistic workload (repeated/popular queries) so aggregation has something to collapse
 *   - shows recency is immediate (per-search) while suggestion recompute is deferred
 *   - shows counts are accurate immediately, suggestions only after the flush
 *   - reports the naive-vs-batched prefix-recompute reduction ratio
 * Run while the server is up: npx tsx scripts/batch-demo.ts
 */
import { openDb } from "../src/db.ts";

const BASE = "http://localhost:3001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = async (url: string) => (await fetch(BASE + url)).json();

// Workload: query -> times searched in the window (popular queries repeated).
const WORKLOAD: Array<[string, number]> = [
  ["London Bridge", 50],
  ["London Eye", 30],
  ["New York City", 20],
  ["Tokyo Tower", 15],
  ["Berlin Wall", 1],
  ["Paris Metro", 1],
];

const prefixCount = (q: string) => {
  const L = q.trim().toLowerCase().length;
  return L < 3 ? 0 : Math.min(L, 20) - 2; // prefixes of length 3..min(L,20)
};

async function post(query: string) {
  await fetch(BASE + "/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

const db = openDb(); // read-only-ish concurrent reader (WAL allows it)
const freqCount = (lower: string) =>
  (db.prepare("SELECT count FROM frequency WHERE query_lower = ?").get(lower) as { count: number } | undefined)?.count;
const basicCountInSuggest = async (prefix: string, display: string) => {
  const r = await j(`/suggest?q=${prefix}&mode=basic`);
  return r.suggestions.find((s: any) => s.query === display)?.count ?? "(not in top10)";
};

async function main() {
  const baseline = freqCount("london bridge");
  console.log(`baseline frequency count (London Bridge) = ${baseline}\n`);

  let naive = 0;
  const N = WORKLOAD.reduce((s, [, t]) => s + t, 0);
  for (const [q, times] of WORKLOAD) {
    for (let i = 0; i < times; i++) await post(q);
    naive += times * prefixCount(q);
  }
  console.log(`sent N=${N} searches across M=${WORKLOAD.length} distinct queries`);
  console.log(`naive (synchronous) prefix recomputes = sum(times × prefixes) = ${naive}\n`);

  // BEFORE flush
  const trend = await j("/trending");
  console.log("BEFORE flush:");
  console.log(`  recency is immediate -> /trending: ${trend.trending.slice(0, 3).map((t: any) => `${t.query}=${t.score}`).join(", ")}`);
  console.log(`  count accurate now   -> frequency(London Bridge) = ${freqCount("london bridge")}  (= ${baseline} + 50)`);
  console.log(`  suggestions STALE    -> basic 'lond' shows London Bridge count = ${await basicCountInSuggest("lond", "London Bridge")}`);

  // wait for the time-triggered flush
  let m = await j("/metrics");
  for (let i = 0; i < 40 && m.batch.batchFlushes < 1; i++) {
    await sleep(200);
    m = await j("/metrics");
  }

  console.log("\nAFTER flush:");
  console.log(`  suggestions FRESH    -> basic 'lond' shows London Bridge count = ${await basicCountInSuggest("lond", "London Bridge")}`);
  const batched = m.batch.prefixRecomputes;
  console.log(`  batched prefix recomputes = ${batched}  (each distinct prefix recomputed once)`);
  console.log(`\n  WRITE REDUCTION: naive ${naive}  vs  batched ${batched}  =>  ${(naive / batched).toFixed(1)}× fewer prefix recomputes`);
  db.close();
}

main();
