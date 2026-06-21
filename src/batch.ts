/**
 * BatchWriter — buffers the EXPENSIVE part of a search write (the ~up-to-18 prefix/suggestion
 * recomputes) and flushes them in aggregate, instead of doing them synchronously per search.
 *
 * Why (CLAUDE.md §13): the single `frequency` count increment is cheap and stays synchronous
 * (so counts are accurate/durable). The costly work is recomputing each affected prefix's
 * top-10 in the `suggestions` table (a range scan + JSON build + upsert per prefix). If a
 * popular query is searched 50× in a window, doing that 50× is wasteful — the 50th recompute
 * sees the same data the 1st would after all increments. So we BUFFER + AGGREGATE: collapse
 * repeats to the distinct set, and recompute each affected prefix ONCE per flush.
 *
 * Flush triggers (whichever first): a size threshold K (bounds buffer growth / staleness
 * under load) or a time interval T (bounds staleness when traffic is light).
 *
 * Failure tradeoff (DESIGN.md §5): the buffer is in-memory. A crash before a flush loses the
 * un-flushed buffer => some suggestion recomputes are skipped (suggestions briefly stale), but
 * NOT counts (those were written synchronously to SQLite). A production system would persist
 * the buffer to a WAL/append-log and replay on restart.
 */

export type BufferedQuery = { lower: string; display: string; count: number };

export class BatchWriter {
  // Aggregation map: query_lower -> { display, count searched this window }.
  private buf = new Map<string, { display: string; count: number }>();
  private pending = 0; // total searches buffered (sum of counts) — drives the size trigger
  private flushing = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private flushSize: number,
    flushMs: number,
    /** Does the actual recompute+invalidate for a batch; returns # prefixes recomputed. */
    private onFlush: (batch: BufferedQuery[], trigger: "size" | "time" | "manual") => Promise<number>
  ) {
    // Time trigger: flush whatever is buffered every T ms.
    this.timer = setInterval(() => void this.flush("time"), flushMs);
    this.timer.unref(); // don't keep the process alive just for the flusher
  }

  /** Buffer one search. Aggregates repeats; fires a size-triggered flush at K. */
  add(rawDisplay: string): void {
    const display = rawDisplay.trim();
    const lower = display.toLowerCase();
    if (!lower) return;
    const e = this.buf.get(lower);
    if (e) e.count++; // repeat in this window -> just bump the aggregate count
    else this.buf.set(lower, { display, count: 1 });
    this.pending++;
    if (this.pending >= this.flushSize) void this.flush("size");
  }

  get pendingCount(): number {
    return this.pending;
  }
  get distinct(): number {
    return this.buf.size;
  }
  snapshot(): BufferedQuery[] {
    return [...this.buf.entries()].map(([lower, e]) => ({ lower, display: e.display, count: e.count }));
  }

  /**
   * Drain and flush the buffer. We snapshot + RESET the buffer synchronously (before any
   * await) so searches arriving during the flush land in a fresh buffer and aren't lost.
   * `flushing` guards against overlapping flushes (size + time firing together).
   */
  async flush(trigger: "size" | "time" | "manual"): Promise<void> {
    if (this.flushing || this.buf.size === 0) return;
    this.flushing = true;
    const batch = this.snapshot();
    this.buf = new Map();
    this.pending = 0;
    try {
      await this.onFlush(batch, trigger);
    } finally {
      this.flushing = false;
    }
  }
}
