/**
 * ring-demo.ts — demonstrates WHY consistent hashing beats `hash % N` when the node
 * count changes, with numbers (DESIGN.md §3). Run: npx tsx scripts/ring-demo.ts
 *
 * We map 100k sample prefixes across 3 nodes, then add a 4th node, and measure how many
 * keys change owner under each scheme. Fewer moved keys = fewer cache entries invalidated.
 */
import { createHash } from "node:crypto";
import { ConsistentHashRing } from "../src/ring.ts";

function h32(key: string): number {
  return createHash("md5").update(key).digest().readUInt32BE(0);
}

// Build sample keys: all 3-letter lowercase prefixes (26^3 = 17,576) ×-ish enough to be representative.
const keys: string[] = [];
const a = "abcdefghijklmnopqrstuvwxyz";
for (const x of a) for (const y of a) for (const z of a) keys.push(x + y + z);

// ---- modulo scheme ----
const moduloOwner = (key: string, n: number) => h32(key) % n;
let moduloMoved = 0;
for (const k of keys) if (moduloOwner(k, 3) !== moduloOwner(k, 4)) moduloMoved++;

// ---- consistent hashing scheme ----
const ring3 = new ConsistentHashRing(["node0", "node1", "node2"]);
const before = new Map(keys.map((k) => [k, ring3.lookup(k)]));
const ring4 = new ConsistentHashRing(["node0", "node1", "node2"]);
ring4.addNode("node3");
let ringMoved = 0;
for (const k of keys) if (before.get(k) !== ring4.lookup(k)) ringMoved++;

// ---- load distribution across the 3-node ring (shows virtual nodes even it out) ----
const dist: Record<string, number> = {};
for (const k of keys) dist[ring3.lookup(k)] = (dist[ring3.lookup(k)] ?? 0) + 1;

const pct = (x: number) => ((100 * x) / keys.length).toFixed(1) + "%";
console.log(`Sample keys: ${keys.length}\n`);
console.log(`Going from 3 -> 4 nodes, keys that change owner:`);
console.log(`  modulo  (hash % N) : ${moduloMoved}  (${pct(moduloMoved)})  <- almost everything remaps`);
console.log(`  ring    (consistent): ${ringMoved}  (${pct(ringMoved)})  <- only ~1/4 moves, rest stay cached\n`);
console.log(`3-node ring load distribution (150 vnodes each):`);
for (const n of Object.keys(dist).sort()) console.log(`  ${n}: ${dist[n]} (${pct(dist[n])})`);
