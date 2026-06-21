/**
 * TrendingTracker — recency-aware scoring, separate from the all-time `frequency` count.
 *
 * LOCKED FORMULA (CLAUDE.md §12), applied once per decay period:
 *
 *       new_score = 0.9 * old_score + recent_count
 *
 * where `recent_count` is how many times the query was searched during the period.
 *
 * Geometric-series intuition:
 *   - A query searched a steady C times every period converges to a fixed point:
 *         s = 0.9*s + C   =>   s = C / (1 - 0.9) = 10C.
 *     So sustained interest settles at 10× the per-period rate (climbs fast at first).
 *   - A query that goes quiet (recent_count = 0) decays geometrically: s *= 0.9 each
 *     period, heading toward 0. THIS DECAY IS THE ANTI-OVER-RANKING MECHANISM — a query
 *     that stops being searched falls off the top on its own; nothing can sit at the top
 *     forever just because it was popular for a day.
 *   - Once a score decays below DROP_THRESHOLD we delete the entry, so the tracker stays
 *     small (self-cleaning) and only holds genuinely-recent queries.
 *
 * Rejected alternative (CLAUDE.md §12): keeping separate total/week/day counters and
 * merging them with a scoring function. The single decayed score is cleaner — one number,
 * self-cleaning, no windows to roll over.
 *
 * Where it lives: in-memory here (sparse, tiny, trivially inspectable). At scale this would
 * be a Redis sorted set so it survives restarts and is shared across app instances
 * (DESIGN.md §4) — the math is identical.
 */

const DECAY_FACTOR = 0.9; // locked
const DROP_THRESHOLD = Number(process.env.TREND_THRESHOLD ?? 0.1);
const MIN_PREFIX = 3;
const MAX_PREFIX = 20;

export type TrendEntry = {
  display: string; // original casing for the UI
  score: number; // decayed historical score (updated only on tick)
  pending: number; // searches THIS period, not yet folded into score
};

export class TrendingTracker {
  private map = new Map<string, TrendEntry>(); // query_lower -> entry

  /** Record one search this period (bumps `pending`). */
  recordSearch(rawDisplay: string): void {
    const display = rawDisplay.trim();
    const lower = display.toLowerCase();
    if (!lower) return;
    const e = this.map.get(lower);
    if (e) e.pending += 1;
    else this.map.set(lower, { display, score: 0, pending: 1 });
  }

  /**
   * Effective current recency used for ranking = decayed history (`score`) PLUS this
   * period's not-yet-folded activity (`pending`). Including `pending` makes a fresh spike
   * visible immediately, instead of only after the next tick. (No double counting: at the
   * tick, `pending` is folded into `score` and reset to 0.)
   */
  effective(lower: string): number {
    const e = this.map.get(lower);
    return e ? e.score + e.pending : 0;
  }

  /**
   * Apply ONE decay period to every tracked query, then drop the faded ones.
   * Returns the set of prefixes (length 3..20) whose enhanced ranking may have shifted —
   * the caller invalidates exactly those trending-mode cache entries.
   */
  tick(): string[] {
    const affected = new Set<string>();
    for (const [lower, e] of this.map) {
      // Every tracked query's score changes this tick, so every one of its prefixes' enhanced
      // rankings is potentially stale — collect them BEFORE a possible drop (a drop also shifts ranks).
      collectPrefixes(lower, affected);

      // THE DECAY (the locked formula): shave 10% off accumulated history, add this period's activity.
      e.score = DECAY_FACTOR * e.score + e.pending;
      e.pending = 0;

      // Self-cleaning: a query that's gone quiet eventually falls below the threshold and is removed.
      if (e.score < DROP_THRESHOLD) this.map.delete(lower);
    }
    return [...affected];
  }

  /** Tracked queries that start with `prefix` (the trending candidates for that prefix). */
  candidatesWithPrefix(prefix: string): Array<{ lower: string; display: string; eff: number }> {
    const out: Array<{ lower: string; display: string; eff: number }> = [];
    for (const [lower, e] of this.map) {
      if (lower.startsWith(prefix)) out.push({ lower, display: e.display, eff: e.score + e.pending });
    }
    return out;
  }

  /** Global top-N trending queries (for the frontend trending section / /trending). */
  top(n: number): Array<{ query: string; score: number }> {
    return [...this.map.values()]
      .map((e) => ({ query: e.display, score: Number((e.score + e.pending).toFixed(3)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  get size(): number {
    return this.map.size;
  }
}

function collectPrefixes(lower: string, into: Set<string>): void {
  const maxK = Math.min(lower.length, MAX_PREFIX);
  for (let k = MIN_PREFIX; k <= maxK; k++) into.add(lower.slice(0, k));
}
