import { createClient, type RedisClientType } from "redis";
import { ConsistentHashRing } from "./ring.ts";

/**
 * Distributed cache layer = the "Top Suggestions DB" in front of SQLite.
 *
 * One Redis instance treated as several logical cache nodes. The consistent-hash ring
 * decides which node owns a prefix; that node name becomes the KEY PREFIX on the real key:
 *
 *     ring.lookup("lond") -> "node1"   =>   key = "node1:suggest:<mode>:lond"
 *
 * MODE is part of the key because basic and trending produce different top-10s for the
 * same prefix, so they must be cached separately (DESIGN.md §2, §4). The ring partitions
 * on the PREFIX only, so both modes of a prefix live on the same node.
 *
 * Strategy is CACHE-ASIDE: check cache, on miss read SQLite and populate with a TTL. Redis
 * is an optimization, not a correctness dependency — every call degrades to a miss if Redis
 * is unavailable.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const CACHE_NODES = (process.env.CACHE_NODES ?? "node0,node1,node2").split(",");
export const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL ?? 300); // 5 min backstop

export type CacheMode = "basic" | "trending";
export type CachedSuggestion = { query: string; count: number };
const ALL_MODES: CacheMode[] = ["basic", "trending"];

export class SuggestionCache {
  private client: RedisClientType;
  readonly ring: ConsistentHashRing;
  private ready = false;
  hits = 0;
  misses = 0;
  // Per-mode so the report can show basic vs trending hit rate (decay only invalidates trending).
  hitsByMode: Record<CacheMode, number> = { basic: 0, trending: 0 };
  missesByMode: Record<CacheMode, number> = { basic: 0, trending: 0 };

  constructor() {
    this.ring = new ConsistentHashRing(CACHE_NODES);
    this.client = createClient({ url: REDIS_URL });
    this.client.on("error", (err) => console.error("[cache] redis error:", err.message));
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      this.ready = true;
      console.log(`[cache] connected to ${REDIS_URL}; logical nodes: ${CACHE_NODES.join(", ")}`);
    } catch (err) {
      this.ready = false;
      console.error(`[cache] no Redis — running without cache:`, (err as Error).message);
    }
  }

  nodeFor(prefix: string): string {
    return this.ring.lookup(prefix); // ring partitions on the prefix, independent of mode
  }
  keyFor(prefix: string, mode: CacheMode): string {
    return `${this.nodeFor(prefix)}:suggest:${mode}:${prefix}`;
  }

  /** Cache read for a (prefix, mode). Returns cached top-10 on a hit, else null. */
  async get(prefix: string, mode: CacheMode): Promise<CachedSuggestion[] | null> {
    if (!this.ready) return null;
    try {
      const raw = await this.client.get(this.keyFor(prefix, mode));
      if (raw === null) {
        this.misses++;
        this.missesByMode[mode]++;
        return null;
      }
      this.hits++;
      this.hitsByMode[mode]++;
      return JSON.parse(raw) as CachedSuggestion[];
    } catch {
      return null;
    }
  }

  async set(prefix: string, mode: CacheMode, value: CachedSuggestion[]): Promise<void> {
    if (!this.ready) return;
    try {
      await this.client.set(this.keyFor(prefix, mode), JSON.stringify(value), { EX: CACHE_TTL_SECONDS });
    } catch {
      /* ignore cache write failures */
    }
  }

  /**
   * Explicit invalidation: drop cached prefixes whose ranks may have changed.
   *  - POST /search  -> invalidate BOTH modes for the searched query's prefixes.
   *  - decay tick    -> invalidate only "trending" for tracked queries' prefixes.
   */
  async invalidate(prefixes: string[], modes: CacheMode[] = ALL_MODES): Promise<void> {
    if (!this.ready || prefixes.length === 0) return;
    const keys: string[] = [];
    for (const p of prefixes) for (const m of modes) keys.push(this.keyFor(p, m));
    try {
      await this.client.del(keys);
    } catch {
      /* ignore */
    }
  }

  /** For /cache/debug. */
  async inspect(
    prefix: string,
    mode: CacheMode
  ): Promise<{ node: string; key: string; cached: boolean; ttl: number }> {
    const node = this.nodeFor(prefix);
    const key = this.keyFor(prefix, mode);
    if (!this.ready) return { node, key, cached: false, ttl: -2 };
    try {
      const ttl = await this.client.ttl(key); // -2 = no key, -1 = no expiry, >=0 = seconds left
      return { node, key, cached: ttl !== -2, ttl };
    } catch {
      return { node, key, cached: false, ttl: -2 };
    }
  }

  async disconnect(): Promise<void> {
    if (this.ready) await this.client.quit();
  }
}
