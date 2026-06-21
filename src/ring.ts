import { createHash } from "node:crypto";

/**
 * ConsistentHashRing — maps a key (here: a /suggest prefix) to one logical cache node.
 *
 * WHY consistent hashing instead of `hash(key) % N` (see DESIGN.md §3):
 * With modulo, the node index depends on N (the node count). Add or remove ONE node and
 * almost every key's `% N` result changes, so the whole cache effectively remaps and
 * every prefix misses at once — a "cache stampede" against the store. With a hash RING,
 * keys and nodes are both placed on the same circular hash space; a key is owned by the
 * next node clockwise. Adding/removing a node only moves the keys in that one arc
 * (~1/N of keys), leaving the rest of the cache valid.
 *
 * WHY virtual nodes:
 * With only N real points on the ring, the arcs between them are very uneven, so load is
 * lopsided and removing a node dumps ALL its keys onto a single neighbour. We instead
 * place V "virtual nodes" per real node (hashing "node#0", "node#1", …). Many small arcs
 * per node => load evens out, and a removed node's keys spread across many neighbours.
 */

export type RingPoint = { hash: number; node: string };

export class ConsistentHashRing {
  private ring: RingPoint[] = []; // ring points, kept sorted by hash ascending
  private nodes = new Set<string>();
  readonly vnodes: number;

  constructor(nodes: string[], vnodes = 150) {
    this.vnodes = vnodes;
    for (const n of nodes) this.addNode(n, /*resort*/ false);
    this.sort();
  }

  /** 32-bit unsigned hash from the first 4 bytes of MD5. MD5 here is just a fast,
   *  well-distributed hash — NOT used for any security purpose. */
  private hash(key: string): number {
    return createHash("md5").update(key).digest().readUInt32BE(0);
  }

  private sort() {
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /** Add a node and its V virtual points to the ring. */
  addNode(node: string, resort = true): void {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.push({ hash: this.hash(`${node}#${i}`), node });
    }
    if (resort) this.sort();
  }

  /** Remove a node and all its virtual points. */
  removeNode(node: string): void {
    if (!this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.ring = this.ring.filter((p) => p.node !== node);
  }

  /**
   * Find the node that owns `key`: the first ring point whose hash is >= the key's hash,
   * wrapping back to the first point if the key is past the last point. Binary search over
   * the sorted ring => O(log R) where R = nodes * vnodes.
   */
  lookup(key: string): string {
    if (this.ring.length === 0) throw new Error("ring is empty");
    const h = this.hash(key);
    // Past the largest point -> wrap around the circle to the first point.
    if (h > this.ring[this.ring.length - 1].hash) return this.ring[0].node;
    let lo = 0;
    let hi = this.ring.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash >= h) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return this.ring[ans].node;
  }

  getNodes(): string[] {
    return [...this.nodes];
  }
}
