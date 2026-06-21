/**
 * bench.ts — measures end-to-end /suggest latency (p50/p95) and cache hit rate against a
 * running server (port 3001), separately for basic and trending mode, cold vs warm cache.
 * Run while the server is up: npx tsx scripts/bench.ts
 *
 * Latencies are END-TO-END over localhost HTTP (so they include the HTTP round-trip and the
 * Redis hop on a hit), which is what a client actually experiences.
 */
const BASE = "http://localhost:3001";

// A spread of real 3–4 letter prefixes that exist in the dataset.
const PREFIXES = [
  "lon", "new", "the", "car", "sci", "mic", "ber", "par", "tok", "wor",
  "ind", "chi", "ame", "eng", "fra", "ger", "rus", "jap", "kor", "bra",
  "can", "aus", "ita", "spa", "mex", "comp", "data", "info", "mus", "art",
  "his", "geo", "math", "phy", "bio", "che", "lit", "pol", "foot", "base",
];
const WARM_ROUNDS = 25;

const now = () => performance.now();
async function timeGet(url: string): Promise<number> {
  const t = now();
  await (await fetch(BASE + url)).text();
  return now() - t;
}
function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(3));
}

async function benchMode(mode: string) {
  const cold: number[] = [];
  for (const p of PREFIXES) cold.push(await timeGet(`/suggest?q=${p}&mode=${mode}`)); // first touch = miss
  const warm: number[] = [];
  for (let r = 0; r < WARM_ROUNDS; r++) for (const p of PREFIXES) warm.push(await timeGet(`/suggest?q=${p}&mode=${mode}`));
  console.log(`\n[${mode}] ${PREFIXES.length} prefixes, cold=${cold.length} reqs, warm=${warm.length} reqs`);
  console.log(`  cold  p50=${pct(cold, 0.5)}ms  p95=${pct(cold, 0.95)}ms`);
  console.log(`  warm  p50=${pct(warm, 0.5)}ms  p95=${pct(warm, 0.95)}ms`);
}

async function main() {
  await benchMode("basic");
  await benchMode("trending");

  const m = await (await fetch(BASE + "/metrics")).json();
  console.log(`\n=== cache hit rate (cumulative over this run) ===`);
  console.log(`  overall : ${(m.cache.hitRate * 100).toFixed(1)}%  (${m.cache.hits} hits / ${m.cache.requests} reqs)`);
  console.log(`  basic   : ${(m.cache.byMode.basic.hitRate * 100).toFixed(1)}%`);
  console.log(`  trending: ${(m.cache.byMode.trending.hitRate * 100).toFixed(1)}%`);
  console.log(`=== DB ops (cache hits skip the DB entirely) ===`);
  console.log(`  reads=${m.db.reads}  writes=${m.db.writes}`);
}

main();
