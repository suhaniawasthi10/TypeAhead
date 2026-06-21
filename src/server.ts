import express from "express";
import type { Request, Response } from "express";
import Database from "better-sqlite3";
import { openDb } from "./db.ts";
import { SuggestionCache, type CachedSuggestion, type CacheMode } from "./cache.ts";
import { TrendingTracker } from "./trending.ts";
import { BatchWriter, type BufferedQuery } from "./batch.ts";

/**
 * TypeAhead API server.
 *
 * Read path (GET /suggest?q=&mode=basic|trending):
 *   - basic    : top-10 by all-time count (precomputed `suggestions`), cache-aside.
 *   - trending : re-rank by a blend of all-time popularity and recency, computed live from
 *                the precomputed basic top-10 ∪ the (small) trending set — NOT a recompute.
 * Write path (POST /search): upsert `frequency`, bump the trending score, recompute the
 *   affected `suggestions` prefixes, and invalidate those prefixes in BOTH cache modes.
 * A background decay tick ages the trending scores and invalidates trending cache entries.
 */
const PORT = Number(process.env.PORT ?? 3001);
const SUGGEST_LIMIT = 10;
const MIN_PREFIX = 3;
const MAX_PREFIX = 20;

// Trending blend: score = RECENCY_WEIGHT * recency + ln(1 + all_time_count).
// We blend recency with the LOG of the count because all-time counts span many orders of
// magnitude (10^2..10^8); the log compresses them so a genuine recent spike can lift a
// query, without recency completely ignoring base popularity. Higher RECENCY_WEIGHT =
// recency needs more volume to matter. (DESIGN.md §4.)
const RECENCY_WEIGHT = Number(process.env.RECENCY_WEIGHT ?? 1.0);
// Decay period: 30 s by default — long enough to be cheap, short enough to watch live.
// Shorter = fresher decay but more frequent tick-invalidations; longer = staler but calmer.
const DECAY_PERIOD_MS = Number(process.env.DECAY_PERIOD_MS ?? 30_000);

// Batch-flush thresholds (M6). Defaults: flush at 100 buffered searches OR every 1 s.
// - K=100 bounds buffer growth / staleness under a traffic burst (flush early when busy).
// - T=1000ms caps suggestion staleness at ~1 s when traffic is light. Both eventual-consistent
//   and fine for typeahead (DESIGN.md §5, §7). Production would tune K/T higher.
const BATCH_FLUSH_SIZE = Number(process.env.BATCH_FLUSH_SIZE ?? 100);
const BATCH_FLUSH_MS = Number(process.env.BATCH_FLUSH_MS ?? 1000);

const db = openDb();
const cache = new SuggestionCache();
const trending = new TrendingTracker();

// Cumulative metrics (surfaced at /metrics). dbReads/dbWrites count actual SQLite statement
// executions, so cache hits (which skip the DB) and batching (which collapse writes) are visible.
const metrics = {
  batchFlushes: 0,
  searchesBuffered: 0,
  distinctFlushed: 0,
  prefixRecomputes: 0,
  dbReads: 0,
  dbWrites: 0,
};

const topKStmt: Database.Statement = db.prepare(`SELECT top_k FROM suggestions WHERE prefix = ?`);
const countStmt: Database.Statement = db.prepare(`SELECT count FROM frequency WHERE query_lower = ?`);
const fallbackStmt: Database.Statement = db.prepare(
  `SELECT query_display AS query, count FROM frequency
    WHERE query_lower >= @lo AND query_lower < @hi ORDER BY count DESC LIMIT @limit`
);

// ---- Write-path statements -----------------------------------------------------------
const freqUpsertStmt: Database.Statement = db.prepare(
  `INSERT INTO frequency (query_lower, query_display, count) VALUES (@lower, @display, 1)
   ON CONFLICT(query_lower) DO UPDATE SET count = count + 1`
);
const recomputeStmt: Database.Statement = db.prepare(
  `SELECT query_display, count FROM frequency
    WHERE query_lower >= @lo AND query_lower < @hi ORDER BY count DESC LIMIT @limit`
);
const suggUpsertStmt: Database.Statement = db.prepare(
  `INSERT INTO suggestions (prefix, top_k) VALUES (@prefix, @topK)
   ON CONFLICT(prefix) DO UPDATE SET top_k = excluded.top_k`
);

/** Basic mode: precomputed top-10 by all-time count, straight from SQLite. */
function readBasicFromStore(prefix: string): CachedSuggestion[] {
  metrics.dbReads++;
  const row = topKStmt.get(prefix) as { top_k: string } | undefined;
  if (!row) return [];
  const arr = JSON.parse(row.top_k) as Array<{ query_display: string; count: number }>;
  return arr.map((e) => ({ query: e.query_display, count: e.count }));
}

/**
 * Enhanced (trending) mode, computed WITHOUT re-running the precompute.
 *
 * Candidate set = basic top-10 (precomputed) ∪ trending queries that start with the prefix.
 * This is provably complete: with blend = W*recency + ln(1+count), any query with zero
 * recency ranks purely by count and therefore cannot beat the basic top-10 — so the only
 * queries that can newly enter the enhanced top-10 are the ones with recency > 0, i.e. the
 * trending set. We re-rank the small union by the blend and take the top 10.
 */
function computeEnhanced(prefix: string): CachedSuggestion[] {
  const cand = new Map<string, { display: string; count: number; eff: number }>();

  for (const b of readBasicFromStore(prefix)) {
    const lower = b.query.toLowerCase();
    cand.set(lower, { display: b.query, count: b.count, eff: trending.effective(lower) });
  }
  for (const t of trending.candidatesWithPrefix(prefix)) {
    if (cand.has(t.lower)) {
      cand.get(t.lower)!.eff = t.eff;
      continue;
    }
    metrics.dbReads++;
    const row = countStmt.get(t.lower) as { count: number } | undefined;
    cand.set(t.lower, { display: t.display, count: row?.count ?? 1, eff: t.eff });
  }

  return [...cand.values()]
    .map((c) => ({ query: c.display, count: c.count, blend: RECENCY_WEIGHT * c.eff + Math.log(1 + c.count) }))
    .sort((a, b) => b.blend - a.blend)
    .slice(0, SUGGEST_LIMIT)
    .map(({ query, count }) => ({ query, count }));
}

/** Cache-aside read for either mode. */
async function suggest(rawQ: string, mode: CacheMode): Promise<CachedSuggestion[]> {
  const lo = rawQ.trim().toLowerCase();
  if (lo.length < MIN_PREFIX) return [];

  if (lo.length <= MAX_PREFIX) {
    const cached = await cache.get(lo, mode);
    if (cached !== null) return cached;
    const fresh = mode === "trending" ? computeEnhanced(lo) : readBasicFromStore(lo);
    await cache.set(lo, mode, fresh);
    return fresh;
  }

  // >20-char tail: live range-scan fallback (basic ranking; rare, not cached).
  metrics.dbReads++;
  const hi = lo + "￿";
  return fallbackStmt.all({ lo, hi, limit: SUGGEST_LIMIT }) as CachedSuggestion[];
}

/** Recompute one prefix's top-10 from the (already-updated) `frequency` table. */
function recomputePrefix(prefix: string): void {
  metrics.dbReads++;
  const top = recomputeStmt.all({ lo: prefix, hi: prefix + "￿", limit: SUGGEST_LIMIT });
  metrics.dbWrites++;
  suggUpsertStmt.run({ prefix, topK: JSON.stringify(top) });
}

/**
 * flushBatch — the deferred, aggregated write (M6). For a batch of DISTINCT queries:
 *   1. Build the UNION of their affected prefixes (3..20). Distinct queries that share a
 *      stem (e.g. "london bridge" / "london eye") share prefixes, so each prefix is
 *      recomputed ONCE — even better than "M distinct × 18".
 *   2. Recompute each prefix from `frequency` (which already has all the synchronous count
 *      increments, so aggregation is naturally correct).
 *   3. Invalidate both cache modes for those prefixes (the M6 cache-invalidation trigger).
 */
async function flushBatch(batch: BufferedQuery[], trigger: string): Promise<number> {
  const prefixSet = new Set<string>();
  for (const q of batch) {
    const maxK = Math.min(q.lower.length, MAX_PREFIX);
    for (let k = MIN_PREFIX; k <= maxK; k++) prefixSet.add(q.lower.slice(0, k));
  }
  const recomputeAll = db.transaction(() => {
    for (const p of prefixSet) recomputePrefix(p);
  });
  recomputeAll();
  await cache.invalidate([...prefixSet]); // both modes — counts changed (basic) and the trending base

  // metrics + the "buffer contents before flush" log (aggregation made visible).
  metrics.batchFlushes++;
  metrics.searchesBuffered += batch.reduce((s, q) => s + q.count, 0);
  metrics.distinctFlushed += batch.length;
  metrics.prefixRecomputes += prefixSet.size;
  const summary = [...batch].sort((a, b) => b.count - a.count).slice(0, 8).map((q) => `${q.display}×${q.count}`).join(", ");
  console.log(
    `[batch] flush(${trigger}): ${batch.reduce((s, q) => s + q.count, 0)} searches → ${batch.length} distinct → ${prefixSet.size} prefix recomputes | ${summary}`
  );
  return prefixSet.size;
}

const batch = new BatchWriter(BATCH_FLUSH_SIZE, BATCH_FLUSH_MS, flushBatch);

const app = express();
app.use(express.json());
// This is a live API — responses must never be served from the browser's HTTP cache,
// or a polled endpoint like /trending would show stale data until a hard reload.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/suggest", async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const mode: CacheMode = req.query.mode === "trending" ? "trending" : "basic";
  const suggestions = await suggest(q, mode);
  res.json({ q, mode, count: suggestions.length, suggestions });
});

app.post("/search", (req: Request, res: Response) => {
  const query = typeof req.body?.query === "string" ? req.body.query : "";
  if (query.trim().length === 0) return res.status(400).json({ error: "query required" });
  // CHEAP + DURABLE, synchronous: bump the all-time count (so counts are always accurate).
  metrics.dbWrites++;
  freqUpsertStmt.run({ lower: query.trim().toLowerCase(), display: query.trim() });
  // RECENCY, synchronous: the tracker must see EVERY search (recency needs the full event
  // stream), even though the prefix recomputes below are deferred.
  trending.recordSearch(query);
  // EXPENSIVE, deferred: buffer the prefix/suggestion recompute for the next flush.
  batch.add(query);
  res.json({ message: "Searched" });
});

// Global top trending queries (for the frontend trending section).
app.get("/trending", (_req: Request, res: Response) => {
  res.json({ periodMs: DECAY_PERIOD_MS, trending: trending.top(10) });
});

app.get("/cache/debug", async (req: Request, res: Response) => {
  const prefix = (typeof req.query.prefix === "string" ? req.query.prefix : "").trim().toLowerCase();
  if (prefix.length === 0) return res.status(400).json({ error: "prefix required" });
  const mode: CacheMode = req.query.mode === "trending" ? "trending" : "basic";
  const info = await cache.inspect(prefix, mode);
  res.json({
    prefix,
    mode,
    node: info.node,
    redisKey: info.key,
    status: info.cached ? "hit" : "miss",
    ttlSeconds: info.ttl,
    totals: { hits: cache.hits, misses: cache.misses },
    ringNodes: cache.ring.getNodes(),
    virtualNodesPerNode: cache.ring.vnodes,
  });
});

app.get("/metrics", (_req: Request, res: Response) => {
  const total = cache.hits + cache.misses;
  const rate = (h: number, m: number) => (h + m === 0 ? null : Number((h / (h + m)).toFixed(4)));
  res.json({
    cache: {
      hits: cache.hits,
      misses: cache.misses,
      hitRate: rate(cache.hits, cache.misses),
      byMode: {
        basic: { hits: cache.hitsByMode.basic, misses: cache.missesByMode.basic, hitRate: rate(cache.hitsByMode.basic, cache.missesByMode.basic) },
        trending: { hits: cache.hitsByMode.trending, misses: cache.missesByMode.trending, hitRate: rate(cache.hitsByMode.trending, cache.missesByMode.trending) },
      },
      requests: total,
    },
    db: { reads: metrics.dbReads, writes: metrics.dbWrites },
    batch: {
      flushes: metrics.batchFlushes,
      searchesBuffered: metrics.searchesBuffered,
      distinctFlushed: metrics.distinctFlushed,
      prefixRecomputes: metrics.prefixRecomputes,
      bufferedNow: batch.pendingCount,
      distinctNow: batch.distinct,
      flushSize: BATCH_FLUSH_SIZE,
      flushMs: BATCH_FLUSH_MS,
    },
    trendingTracked: trending.size,
  });
});

app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

async function start() {
  await cache.connect();

  // Background decay tick: age every trending score by the locked formula, then invalidate
  // the trending-mode cache for every prefix whose ranking just shifted.
  const timer = setInterval(async () => {
    const affected = trending.tick();
    if (affected.length > 0) {
      await cache.invalidate(affected, ["trending"]);
      console.log(`[trending] decay tick: ${trending.size} tracked, invalidated ${affected.length} trending prefixes`);
    }
  }, DECAY_PERIOD_MS);
  timer.unref(); // don't keep the process alive just for the tick

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT} (decay period ${DECAY_PERIOD_MS}ms)`);
    console.log(`[server] try: /suggest?q=lon&mode=trending  and  /trending`);
  });
}
start();
