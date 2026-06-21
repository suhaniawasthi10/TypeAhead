# API Reference

Base URL: `http://localhost:3001`. All responses are JSON.

---

## `GET /suggest`
Prefix suggestions. The primary read endpoint.

**Query params**
| param | type | default | notes |
|---|---|---|---|
| `q` | string | `""` | the prefix. Trimmed and lowercased server-side (case-insensitive). |
| `mode` | `basic` \| `trending` | `basic` | `basic` = all-time count; `trending` = recency-blended. |

**Response** `200`
```json
{ "q": "lond", "mode": "basic", "count": 10,
  "suggestions": [ { "query": "London", "count": 208223 }, ... ] }
```
`suggestions` is ≤10 items, sorted best-first, each `query` in original display casing.

**Edge cases (all return `200`, never an error):**
- Missing / empty / whitespace `q` → `{ "count": 0, "suggestions": [] }`.
- Prefix shorter than 3 chars → empty list (the trending/short path; not served from the
  suggestion store).
- No matching prefix → empty list.
- Mixed case (`LOND`) → identical to `lond`.
- Prefix 3–20 chars → O(1) cache/precomputed lookup. Prefix >20 chars → range-scan fallback.

---

## `POST /search`
Record a submitted search.

**Body**
```json
{ "query": "London Bridge" }
```

**Response** `200`
```json
{ "message": "Searched" }
```
`400 { "error": "query required" }` if `query` is missing/empty/whitespace.

**Behavior:** synchronously increments the all-time count in `frequency` (matched by
lowercased query; inserts with count 1 if new, preserving submitted casing) and updates the
recency score. The prefix/suggestion recompute is **buffered** and applied on the next batch
flush, so the new search surfaces in `/suggest` after the flush (≤ ~1s). Counts are durable
immediately; only suggestion freshness is deferred (DESIGN.md §5, §7).

---

## `GET /trending`
Global top trending queries by recency score.

**Response** `200`
```json
{ "periodMs": 30000, "trending": [ { "query": "London Bridge", "score": 12 }, ... ] }
```
`score` is the live recency value (`0.9·old + recent_count` per period, plus the current
period's pending activity).

---

## `GET /cache/debug`
Inspect the cache placement and state for a prefix.

**Query params:** `prefix` (required), `mode` (`basic`|`trending`, default `basic`).

**Response** `200`
```json
{ "prefix": "lond", "mode": "basic",
  "node": "node0", "redisKey": "node0:suggest:basic:lond",
  "status": "hit", "ttlSeconds": 300,
  "totals": { "hits": 1, "misses": 1 },
  "ringNodes": ["node0","node1","node2"], "virtualNodesPerNode": 150 }
```
`node` is the logical cache node the consistent-hash ring assigns to this prefix; `status`
is `hit` if the key is currently cached, else `miss`. `400` if `prefix` is empty.

---

## `GET /metrics`
Operational metrics (used by the performance report).

**Response** `200`
```json
{
  "cache": {
    "hits": 2000, "misses": 80, "hitRate": 0.9615, "requests": 2080,
    "byMode": {
      "basic":    { "hits": 1000, "misses": 40, "hitRate": 0.9615 },
      "trending": { "hits": 1000, "misses": 40, "hitRate": 0.9615 }
    }
  },
  "db": { "reads": 80, "writes": 0 },
  "batch": {
    "flushes": 0, "searchesBuffered": 0, "distinctFlushed": 0, "prefixRecomputes": 0,
    "bufferedNow": 0, "distinctNow": 0, "flushSize": 100, "flushMs": 1000
  },
  "trendingTracked": 0
}
```
`db.reads`/`db.writes` count actual SQLite statement executions — cache hits skip the DB, so
`reads` ≈ cache misses; batching keeps `writes` far below the naive per-search count.

---

## `GET /health`
`200 { "ok": true }` — liveness check.
