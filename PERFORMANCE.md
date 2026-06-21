# Performance Report

All numbers are from actual demo runs on the dev machine (Node 22, Redis 8.8, SQLite, macOS,
dataset = enwiki Clickstream 2026-05, 200k titles). Reproduce with the scripts noted per
section. Organised to map onto the 60 / 20 / 20 grading bands.

---

## Band 1 — Basic implementation: latency + hit rate

**Method:** `npx tsx scripts/bench.ts` against a running server — 40 distinct real prefixes,
each hit once cold (cache miss) then 25× warm (1000 warm requests/mode). Latency is
**end-to-end over localhost HTTP** (includes the HTTP round-trip and the Redis hop on a hit).

**Latency (`/suggest`, basic mode):**
| | p50 | p95 |
|---|---|---|
| Warm cache (steady state) | **0.31 ms** | **0.43 ms** |
| Cold cache (first touch, incl. process/JIT/connection warm-up) | 0.64 ms | 2.53 ms |

**Cache hit rate:** **96.2%** overall (2000 hits / 2080 requests). The 80 misses are exactly
the 80 first-touch requests (40 prefixes × 2 modes); every subsequent request is a hit.

**DB read/write counts:** **80 reads, 0 writes** across **2080** `/suggest` requests — i.e.
the cache absorbed ~96% of reads; only the 80 cold misses touched SQLite, and no `/search`
ran so there were no writes. This is the cache-aside payoff in one line: 2080 requests, 80
DB reads.

> Conditions: warm = cache populated; cold = first request per prefix. Decay period set long
> so ticks didn't perturb the run.

---

## Band 2 — Trending (recency-aware ranking)

**Basic vs trending reorder** (`scripts/batch-demo.ts` / manual): after spiking
"London Bridge", for prefix `lond`:

| rank | basic (all-time count) | trending (recency blend) |
|---|---|---|
| 1 | London (208,223) | **London Bridge (26,658)** ⬆ from #10 |
| 2 | London Stadium | London |
| 10 | **London Bridge** | London Borough of Havering |

A recently-spiked query jumps **#10 → #1** under trending while basic is unchanged.

**Decay over time** (`scripts/trending-demo.ts`, steady C=5/period; fixed point = 10C = 50):
```
ACTIVE:  5.0 → 9.5 → 13.55 → 17.2 → 20.5 → 23.4 → 26.1 → 28.5   (climbing toward 50)
QUIET:   25.6 → 23.1 → 20.8 → … → 1.09 → DROPPED at period 40   (×0.9/period, self-cleans)
```
The decay is the anti-over-ranking mechanism: a query that stops being searched falls off the
top and is removed.

**Trending-mode latency:** on a cache **hit**, trending and basic do identical work (a Redis
fetch), so latency is the same (~0.3 ms p50, warm). Trending's extra work — the
basic-top-10 ∪ trending-set re-rank — only happens on a **miss**, and over the small trending
set it is sub-millisecond. (Measured warm: trending p50 0.26 ms / p95 0.36 ms.)

**Cache interaction note:** trending hit rate matches basic in a quiet run, but **drops when
decay ticks fire**, because each tick invalidates the trending-mode cache for tracked
prefixes (verified separately: a tick logged "invalidated 11 trending prefixes"). Basic
hit rate is unaffected by decay (separate keys), which keeps the basic number honest.

---

## Band 3 — Batch writes (write reduction)

**Method:** `scripts/batch-demo.ts` — 117 searches across 6 distinct queries (popular ones
repeated) in one flush window, then read `/metrics`.

**Aggregation** (server flush log):
```
[batch] flush(time): 117 searches → 6 distinct → 52 prefix recomputes
                     | London Bridge×50, London Eye×30, New York City×20, Tokyo Tower×15, ...
```

**Write reduction (expensive prefix/suggestion recomputes):**
| | prefix recomputes |
|---|---|
| Naive (synchronous, per search) | Σ(times × prefixes) = **1163** |
| Batched (aggregate → union of prefixes, recompute once) | **52** |
| **Reduction** | **22.4×** |

Measured on the **prefix/suggestion recomputes** (the costly DB work), not the count
increments — those stay 1-per-search and durable by design. Both flush triggers were
exercised: `flush(size)` at K=100 and `flush(time)` at T=1s.

**Correctness preserved:** counts are accurate immediately (frequency = baseline + 50 right
after the workload, before any flush); suggestions reflect the change only after the flush;
recency is immediate (`/trending` showed all 117 searches pre-flush).
