# DESIGN.md

Plain-language design rationale for the TypeAhead system. For each concept: what I
chose, **why**, what the alternatives were, why I rejected them, and the tradeoff I'm
accepting.

---

## 1. Data storage for query counts

I use the **two-layer model from the notes**:

- **Search Frequency DB** — SQLite table `frequency(query_lower, query_display, count)`.
  The **source of truth**: query → count. `query_lower` is the lowercased match key
  (and carries the index used by the long-prefix fallback); `query_display` keeps the
  original casing so the UI shows "Michael Jackson", not "michael jackson".
- **Top Suggestions DB** — SQLite table `suggestions(prefix, top_k)`. The **precomputed
  `prefix → top-k` layer** ("data-augmentation == cache"): one row per distinct prefix of
  length 3–20, where `top_k` is a JSON array of up to 10 `{query_display, count}` sorted
  by count desc. In production this layer is the Redis cache (M4); locally it's a table.

### Eager precompute vs lazy compute-on-read — and why eager

**Choice: eager precompute.** At load time we generate, for every title, all its prefixes
(length 3–20) and store each prefix's top-10 once. A `/suggest` read is then an **O(1) key
fetch** on `suggestions` — no scanning, no sorting at request time.

**Why eager is right *here*:** typeahead's prefix set is **small and fully knowable at
load time** — we already hold all 200k titles, so the set of prefixes worth serving is
finite and computable up front. That's the exact condition under which precomputing pays
off, and it matches the notes' canonical prefix→top-k design.

**Why I rejected lazy (compute-on-read / range-scan-per-request):** lazy is the right
choice when the key space is **unbounded or unknowable** — you can't precompute what you
can't enumerate, so you compute on demand and cache results. Typeahead's key space is
neither. Lazy also has a concrete failure mode I measured: a **range scan on short
prefixes** (e.g. one or two significant letters) matches a huge slice of the table and
must sort it by count on every request. My earlier lazy build did exactly this and a
1–3 char prefix cost up to ~80 ms, while the eager build serves the same prefix as a
**~0.5 ms key fetch**. Eager removes that short-prefix cliff entirely.

**The alternatives the notes/options raise, and why not the source of truth:**
- **Trie** — natural for prefix search, but it's an in-memory structure that isn't durable
  across restarts without extra serialization work, and the precomputed-table approach
  gives the same O(prefix) lookup while staying on disk. (The `suggestions` table *is*
  the materialized equivalent of a trie's prefix→top-k answers.)
- **Redis ZSET per prefix** — great for the *cache* layer and effectively what M4 does,
  but Redis is volatile; I keep the durable source of truth in SQLite and reserve Redis
  for the cache where consistent hashing lives.

### The 3–20 bound and the long-prefix fallback (the deliberate tradeoff)

You **can't precompute infinitely long prefixes**, so I bound the eager set:

- **Min 3 chars** — "start suggesting after 3 letters." Prefixes < 3 chars go to the
  trending/empty path (M5), not the suggestion store.
- **Max 20 chars** — prefixes of length 3–20 are precomputed.
- **> 20 chars → range-scan fallback** on the Search Frequency DB
  (`query_lower >= prefix AND query_lower < prefix + ￿`, using `idx_frequency_lower`).

This is a **hybrid**: eager for the common case (almost all real typeahead prefixes are
short), lazy for the rare long-prefix tail. The fallback is cheap precisely *because* a
20+ char prefix matches very few rows, so the range scan that was expensive for short
prefixes is trivial here. **Tradeoff accepted:** a bounded precompute (more load-time work
and ~187 MB on disk: 200k frequency rows + 1.51M precomputed prefixes) in exchange for
O(1) reads, with a small lazy fallback covering what we deliberately chose not to
precompute.

### Ingestion performance — the fast loader (implemented)

The first loader did **one UPSERT per source row** to aggregate incrementally; on the
35.4M-row enwiki dump that took **~2.5 hours**, because every row paid for a B-tree
lookup/update on a growing index. The rebuilt loader (`scripts/load.ts`) does it the fast
way — **never maintaining an index during the 35M-row ingest**:

1. **Bulk-INSERT** raw `(display, n)` rows into an **unindexed `staging` table** — pure
   appends. (35.4M rows in **36.5 s**.)
2. **Aggregate in set-based SQL passes**: collapse identical titles, merge case-variants
   under one lowercase key, total counts, keep the **top 200k** by count → `frequency`.
   (**63.2 s**.)
3. **Precompute** `suggestions` from `frequency` in **one windowed SQL pass** (recursive
   CTE generates prefixes; `ROW_NUMBER() … PARTITION BY prefix ORDER BY count DESC` picks
   top-10; `json_group_array` materializes them). → 1.51M prefixes in **4.6 s**.
4. **Create indexes LAST**, drop staging, VACUUM. (**5.4 s**.)

**Total: ~110 s, down from ~2.5 h (≈80× faster).** Same memory-flat property (SQLite
manages the sorts on temp storage), but set-based instead of row-by-row.

**Tradeoff accepted:** the staging table uses extra temporary disk during the load
(dropped afterward) — a non-issue for a one-time build, and well worth the 80× speedup.

---

## 2. Caching strategy

**What is cached:** `prefix → top-10` — exactly the `/suggest` result for a prefix (a JSON
array of `{query, count}`). This is the "Top Suggestions DB" layer living in Redis, in
front of the precomputed `suggestions` table in SQLite.

**Choice: cache-aside.** The app checks the cache; on a miss it reads SQLite and then
populates the cache with a TTL. (`src/server.ts` `suggest()` + `src/cache.ts`.)

- **Why cache-aside:** the cache is a pure optimization, not a correctness dependency — if
  Redis is down or errors, every `get` simply returns "miss" and we serve from SQLite, so
  the system still works (verified: the cache layer swallows Redis errors and degrades to
  misses). The app stays in full control of what gets cached and when.
- **Read-through rejected:** read-through makes the *cache* responsible for loading from
  the store on a miss (via a cache library/proxy that knows how to fetch). That couples the
  cache to the store and hides the load path; our "store read" is a trivial precomputed-row
  lookup we'd rather keep in the app. No real benefit here.
- **Write-through rejected:** write-through pushes every write through the cache into the
  store synchronously, tying write latency to the cache. But on a write we want to
  *invalidate* affected prefixes, not re-populate them (recomputing top-10 is heavier than
  a delete), and M6 will make writes batched/asynchronous — the opposite of write-through.

**TTL vs explicit invalidation — and when each fires:**
- **Explicit invalidation** fires on **every write**: `POST /search` recomputes the
  affected prefixes in SQLite and then `DEL`s exactly those prefix keys from Redis, so the
  next `/suggest` re-reads fresh data. This gives near-immediate consistency for the
  prefixes that actually changed (verified). M5 (trending rank shifts) and M6 (batch flush)
  are additional invalidation triggers.
- **TTL (300 s)** is the **backstop**: it bounds how long *any* entry can be stale even if
  an invalidation is missed (a dropped `DEL`, a code path we forgot, a rank drift). It's
  the safety net; invalidation is the primary mechanism.

**Tradeoff accepted:** a read right after a write, for a prefix whose `DEL` hasn't landed
yet, can serve a stale top-10 for up to the TTL — acceptable for typeahead (§7).

## 3. Consistent hashing

**The set-up:** the cache is partitioned across **logical nodes**. Locally that's one Redis
instance with three logical nodes (`node0`, `node1`, `node2`); the node a prefix maps to
simply becomes the **key prefix** on the real Redis key — `ring.lookup("lond") = "node1"`
⇒ key `node1:suggest:lond`. So the ring genuinely decides the partition (verified: `lond`→
node0, `mic`→node1, `lon`→node2, …). At planet scale each logical node is a separate Redis
server; the mechanism is identical (CLAUDE.md §14).

**Why consistent hashing instead of `hash(key) % N`:** with modulo, the owning node is a
function of `N`. Change `N` (add or remove a cache node) and almost every key's `% N` value
changes, so the entire cache remaps at once and every prefix misses simultaneously — a
stampede onto the store. With a **hash ring**, keys and nodes share one circular hash
space and a key is owned by the next node clockwise; adding/removing a node only reassigns
the keys in that one arc.

**Measured (`scripts/ring-demo.ts`, 17,576 sample prefixes, 3 → 4 nodes):**

| Scheme | Keys that change owner |
|---|---|
| `hash % N` (modulo) | **75.6%** — almost the whole cache invalidates |
| Consistent-hash ring | **21.7%** — only ~1/4 moves; the rest stay cached |

**Virtual nodes — why needed:** with only 3 real points on the ring, the arcs between them
are wildly uneven (lopsided load), and removing a node dumps *all* its keys onto a single
neighbour. We place **150 virtual nodes per real node** (hashing `"node0#0"`, `"node0#1"`,
…), so each node owns many small arcs scattered around the ring. Result: load evens out
(measured 31% / 31% / 38% across the three nodes) and a removed node's keys spread across
many neighbours instead of one. **Tradeoff:** more virtual nodes → tighter balance but a
larger ring to store/search; 150 is a good balance (ring search is O(log R) anyway).

**How a key finds its node:** hash the key to a 32-bit int (first 4 bytes of MD5 — used
purely as a fast, well-distributed hash, not for security), then **binary-search** the
sorted ring for the first point with `hash ≥ keyHash`, wrapping to the first point if the
key is past the end. O(log R) where R = nodes × vnodes. (`src/ring.ts` `lookup()`.)

**Note vs the notes (CLAUDE.md §10):** the notes sketch **first-N-letter sharding** for the
*data store* (e.g. all "a*" prefixes on one shard). That's a fine static partition, but it
doesn't survive node add/remove gracefully and skews with letter frequency. The assignment
asks for **consistent hashing on the cache**, which both balances load (via virtual nodes)
and survives node churn without rehashing everything — so that's what I built, and I keep
the explicit ring rather than leaning on any "hashing is automatic" hand-wave.

**Weakness I'll own:** logical nodes on one Redis process don't give real fault isolation —
if that process dies, all "nodes" die. It demonstrates the *partitioning mechanism*, not
physical redundancy. Real multi-node Redis would add that; out of scope locally (§14... see
Future Scope).

## 4. Trending / recency

**Two modes on the same `/suggest` API** (`?mode=basic|trending`, default basic):
- **basic** — top-10 by all-time count (the precomputed `suggestions` table).
- **trending** — re-rank by a blend of all-time popularity and recent activity.

**The scoring formula (locked):** per decay period,

> **`new_score = 0.9 * old_score + recent_count`**

where `recent_count` is the number of searches for that query during the period.
- **Geometric intuition:** a query searched a steady `C` times/period converges to the
  fixed point `s = 0.9s + C ⇒ s = C/(1−0.9) = 10C` (climbs fast, then settles at 10×).
  A query that goes quiet decays `s *= 0.9` each period toward 0.
- **The decay IS the anti-over-ranking mechanism:** stop searching a query and it falls
  off the top on its own — nothing can sit at the top forever from one popular day. Once a
  score drops below a small threshold the entry is deleted, so the tracker is self-cleaning.
- **Demonstrated** (`scripts/trending-demo.ts`): 5/period climbs 5 → 9.5 → 13.55 → … → 28.5
  (toward 50), then on going quiet decays back down and is **dropped** once below threshold.
- **Rejected alternative (CLAUDE.md §12):** separate total/week/day counters merged by a
  scoring function. One decayed score is cleaner — a single number, self-cleaning, no
  windows to roll.

**Decay period:** 30 s by default (configurable), chosen so it's cheap yet observable live.
**Tradeoff:** shorter period = fresher decay but more frequent tick-invalidations (more
cache churn + recompute); longer = calmer but staler trending. The tick only touches the
small set of currently-tracked prefixes, so the cost scales with active trending, not the
whole dataset.

**Where the score lives:** an in-memory `TrendingTracker` (`Map<query_lower → {score,
pending}>`), separate from the all-time `frequency` count. It's *sparse* — only recently
searched queries have non-zero scores, and decay drops the rest — so it stays tiny and
inspectable. `pending` holds this period's searches (folded into `score` at the tick);
ranking uses `score + pending` so a fresh spike shows immediately, not only after a tick.
**Scale-up note:** in production this is a Redis sorted set (durable, shared across app
instances); the math is identical.

**The blend (my choice; the decay formula above is the locked part):**

> **`blend = RECENCY_WEIGHT * (score + pending) + ln(1 + all_time_count)`**

We blend recency with the **log** of the all-time count because counts span many orders of
magnitude (10²–10⁸); the log compresses them so a genuine recent spike can lift a query
without recency completely ignoring base popularity. Higher `RECENCY_WEIGHT` ⇒ recency
needs more volume to matter.

### Computing enhanced mode WITHOUT re-running the precompute (the part to get right)

Enhanced rankings change continuously, so we can't bake them into the precomputed table.
But we don't need to recompute everything either. **Claim:** the enhanced top-10 for a
prefix is always a subset of `basic_top10(prefix) ∪ {trending queries starting with the
prefix}`. **Why:** with `blend = W·recency + ln(1+count)` (monotonic non-decreasing in
recency), any query with **zero** recency ranks purely by count, so it can't beat the
precomputed basic top-10. Therefore the only queries that can newly enter the enhanced
top-10 are those with recency > 0 — i.e. the (small) trending set. So enhanced mode is: one
O(1) fetch of the precomputed basic top-10, a scan of the small trending set filtered to
the prefix, union, re-rank by the blend, take 10. Cheap, and correct.

**Verified:** prefix `lond` — `London Bridge` is **basic #10** (count 26,658) but **trending
#1** after a spike, pushing `London` (all-time #1) to #2. Exactly the recency behaviour.

### Cache invalidation when ranks shift

Cache keys are **mode-namespaced** (`node:suggest:basic:prefix` vs `…:trending:prefix`)
since the two modes give different top-10s. Two triggers fire the M4 invalidation hook:
1. **`POST /search`** — invalidates **both** modes for the searched query's prefixes (its
   count and its recency both changed). Verified: trending key for `lond` goes hit → miss
   on a write.
2. **Decay tick** — every period, all tracked scores change, so the tick invalidates the
   **trending** mode for every tracked query's prefixes (basic is unaffected by decay, so we
   leave it). Verified: tick log "1 tracked, invalidated 11 trending prefixes".

This is complete: `pending` changes only on `/search` (which invalidates that query's
prefixes); `score` changes only on the tick (which invalidates all tracked prefixes); so
between events every cached enhanced result is still valid.

**Weakness I'll own:** the tracker is in-memory (lost on restart — acceptable, recency is
ephemeral) and the tick invalidates *all* tracked trending prefixes each period rather than
only those whose order actually changed — fine while the trending set is small, but at scale
you'd want the Redis-ZSET version and finer-grained invalidation.

## 5. Batch writes

**The split.** A `POST /search` does two kinds of work: a **cheap** `frequency` count
increment, and the **expensive** recompute of every affected prefix's top-10 in the
`suggestions` table (a range scan + JSON build + upsert per prefix — up to ~18 per search).
M6 keeps the count synchronous (accurate + durable) and **defers + aggregates** the
expensive prefix recomputes.

**Buffer vs queue vs log — what I chose and why:**
- **In-memory buffer (chosen)** — a `Map<query_lower → count>` that aggregates repeats. It's
  the simplest thing that enables the key win (collapsing repeats), with near-zero overhead.
  Weakness: not durable (see crash question below).
- **Queue (e.g. Redis list / message queue) — rejected:** durable and decouples
  producer/consumer, but a plain queue doesn't *aggregate* on its own (50 searches = 50
  queue entries), and it adds infrastructure I don't need at local scope.
- **Write-ahead / append log — rejected for now (but it's the durability fix):** append every
  event to a durable log, then process. Survives crashes via replay, but more moving parts
  than the assignment needs. I discuss it as the production durability answer below.

**Flush triggers (whichever fires first):**
- **Size K = 100 buffered searches** — bounds buffer growth and staleness under a burst
  (flush early when busy).
- **Time T = 1000 ms** — bounds staleness when traffic is light (a lone search still lands
  within ~1 s).
Both configurable; production would tune them higher. Verified both fire (logs show
`flush(size)` and `flush(time)`).

**Aggregation — the whole point.** At flush we take the DISTINCT queries, build the **union**
of their affected prefixes, and recompute each prefix **once** (distinct queries sharing a
stem share prefixes, so this beats even "M × 18"). Because counts were already incremented
synchronously, the single recompute reads the correct totals.

**Write-reduction (the graded number), measured.** Workload: 117 searches across 6 distinct
queries (popular ones repeated), in one window:

| | prefix recomputes |
|---|---|
| Naive (synchronous, per search) | Σ(times × prefixes) = **1163** |
| Batched (this design) | distinct prefixes recomputed once = **52** |
| **Reduction** | **22.4× fewer expensive writes** |

This is measured on the **prefix/suggestion recomputes**, not the count increments — those
stay 1-per-search by design.

**The crash question (durability vs throughput).** What's lost if the process dies before a
flush?
- **`frequency` counts are safe.** They're written synchronously, each `POST /search` its own
  transaction, to SQLite in WAL mode — durable across an application crash. (Honest nuance:
  with `synchronous=NORMAL` in WAL, a power-loss/OS-crash can lose the very last commit(s);
  an app/process crash cannot.)
- **The un-flushed buffer is lost.** That means some prefix **recomputes are skipped**, so the
  affected prefixes' `suggestions` rows stay **stale** (showing the pre-search ranking) until
  one of those queries is searched again (re-buffering the prefix) or the dataset is reloaded.
  **This is delayed/stale suggestions, NOT count loss** — the durable counts let us always
  rebuild correct suggestions later.
- **Tradeoff:** larger buffers / longer flush intervals = higher throughput and better
  aggregation, but a bigger window of at-risk recomputes and staler suggestions. Smaller =
  fresher and less at risk, but less aggregation benefit.

**How production would close the durability gap (not built here):** append each buffered
event to a **WAL/append-only log** before acking the search; on restart, replay the
un-flushed tail and recompute. Alternatively flush more frequently (smaller risk window, less
aggregation) or simply accept the eventual consistency — which is what we do at assignment
scope, because losing a little suggestion freshness (never counts) is acceptable here (§7).

**Interaction with M4/M5 (kept correct):**
- The **flush** is the M6 trigger for the M4 invalidation hook: after recomputing the union
  of prefixes it invalidates both cache modes for them.
- **Trending is unaffected:** `trending.recordSearch` runs synchronously on every `POST
  /search`, so recency sees the full event stream even though prefix recomputes are deferred.
  Verified: `/trending` reflects all 117 searches *before* any flush, while basic suggestions
  still showed the old count until the flush landed.

## 6. Debouncing

**Choice:** Debounce the search input on the **frontend** with a 150 ms delay
(`useDebounce` hook in `web/src/App.tsx`) — a `/suggest` request fires only after the
user pauses typing, not on every keystroke.

**Why on the frontend:** the wasteful work is the *network request itself*. Typing
"london" is 6 keystrokes in under a second; without debouncing that's 6 HTTP requests,
5 of which are stale before they return. Debouncing on the client stops those requests
from ever leaving the browser, so the backend, the cache, and the DB never see them.
Debouncing on the *server* wouldn't help — the requests would already have crossed the
network and hit the server before it could decide to ignore them. The whole point is to
suppress them at the source.

**What it saves the backend:** roughly an N× reduction in `/suggest` load for a typed
word of N characters (a 6-letter word → ~1 request instead of ~6). That directly lowers
QPS, cache lookups, and DB range scans, and makes the p95 latency numbers (see
PERFORMANCE.md) reflect real distinct queries rather than keystroke spam.

**Also added (related race fix):** each new request aborts the previous one
(`AbortController`), so a slow earlier response can't overwrite suggestions for a newer
prefix.

**Tradeoff accepted:** ~150 ms of perceived delay before suggestions appear. That's
below the threshold a typing user notices, and it's the knob — too low wastes requests,
too high feels laggy.

## 7. CAP / consistency

**Is the suggestion path eventually consistent? Yes — and that's the right call here.**

**Why it's acceptable (the workload argument):**
- **Read-heavy** — a typeahead fires many `/suggest` reads per keystroke-burst and only the
  occasional `/search` write (~10× more reads than writes, and debouncing widens that gap).
- **Stale reads are fine** — users don't know or care about the exact counts; the precise
  ordering of suggestions doesn't matter; a momentarily-missing good suggestion is a
  non-event while someone is mid-typing.
- **Small data loss is fine** — counts being off by a little changes nothing a user perceives.

So we optimize accordingly: **absorb reads in the cache, optimize the store for writes**, and
let the suggestion path be eventually consistent rather than paying for strong consistency we
don't need.

**One write, traced end to end:**
```
POST /search "London Bridge"
  → SYNC: frequency.count++            (durable in SQLite/WAL — the source of truth)
  → SYNC: trending.recordSearch(...)   (recency updated immediately)
  → buffer the prefix recompute        (NOT done synchronously)
  ── later ──
  → flush (size K or time T): recompute affected prefixes from frequency → suggestions
  → invalidate the affected cache keys (both modes)
  → next GET /suggest: cache miss → reads the fresh suggestions row → repopulates cache
```

**The three staleness layers (where "eventual" lives):**
1. **Un-flushed buffer** — between the search and the flush, the `suggestions` table hasn't
   been recomputed yet, so basic suggestions show the pre-search ranking (≤ flush interval).
2. **Stale cache** — even after the table updates, a cached entry serves the old value until
   it's invalidated (by the flush) or its TTL expires.
3. **Trending recompute timing** — recency scores age only on the decay tick, so trending
   order shifts at period boundaries, and trending cache entries are stale until the tick (or
   a write) invalidates them.

Each layer is bounded (flush interval, TTL, decay period), so the system converges quickly.

**The key safety property:** the *derived* data (suggestions, trending) is always
**recoverable from the durable counts**. The `frequency` counts are written synchronously and
survive a crash (WAL); the `suggestions` table and the recency scores are just materialized
views over them. So the worst case of a lost buffer or a stale cache is *delayed freshness*,
never *lost truth* — we can always rebuild correct suggestions from the counts.

**Alternative considered — strong consistency:** make every `/search` synchronously recompute
and write all affected prefixes (and skip caching, or write-through). **Rejected:** it ties
write latency and throughput to the expensive recompute for a guarantee users can't perceive,
and it throws away the batching win (§5). **Tradeoff accepted:** bounded staleness on a
read-mostly path in exchange for fast writes, high cache hit rates, and far fewer DB writes.

---

## Future scope (in the notes, deliberately NOT built)

Out of the rubric or not meaningful to run locally — listed so the boundary is explicit:

- **Planet-scale fan-out (~100 cache servers):** at planet scale you'd shard across ~100
  separate Redis nodes; here I demonstrate the *same* consistent-hashing mechanism locally
  with logical key-prefix nodes on one Redis instance.
- **Geolocation sharding:** route/shard suggestions by region so trends are locale-aware.
- **Spell-correction / fuzzy matching:** tolerate typos in the prefix (edit-distance / n-grams).
- **Client-side personalization:** rank using the individual user's history, not just global
  popularity.
- **Tab-to-complete / inline completion:** richer client UX beyond the dropdown.
- **Durable write buffer (WAL/append-log):** persist the batch buffer so un-flushed writes
  survive a crash (the durability fix discussed in §5).
