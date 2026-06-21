/**
 * trending-demo.ts — shows the locked decay formula climbing then decaying over periods,
 * driving the tracker directly (no server, no real-time waiting).
 *   new_score = 0.9 * old_score + recent_count    (fixed point for steady C/period = 10C)
 * Run: npx tsx scripts/trending-demo.ts
 */
import { TrendingTracker } from "../src/trending.ts";

const t = new TrendingTracker();
const Q = "London Bridge";
const C = 5; // steady searches per period during the "active" phase
const lower = Q.toLowerCase();

function tickAndLog(label: string) {
  t.tick();
  // After tick, effective == score (pending folded in). Read it back.
  const score = t.candidatesWithPrefix(lower)[0]?.eff ?? 0;
  console.log(`  ${label.padEnd(22)} score = ${score.toFixed(3)}`);
}

console.log(`Query: "${Q}",  steady rate C=${C}/period,  expected fixed point = C/(1-0.9) = ${10 * C}\n`);

console.log("ACTIVE (searched C times each period — climbs toward 10C):");
for (let p = 1; p <= 8; p++) {
  for (let i = 0; i < C; i++) t.recordSearch(Q);
  tickAndLog(`period ${p} (+${C})`);
}

console.log("\nQUIET (no searches — decays *0.9 each period, dropped below threshold):");
for (let p = 9; p <= 45; p++) {
  const before = t.size;
  tickAndLog(`period ${p} (+0)`);
  if (before > 0 && t.size === 0) {
    console.log(`  --> decayed below threshold and DROPPED at period ${p} (can't sit at the top forever)`);
    break;
  }
}
