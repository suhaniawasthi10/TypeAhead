import Database from "better-sqlite3";

/**
 * Single source of truth for where the SQLite DB lives and the two-layer schema.
 * Both the load script and the API server import from here.
 *
 * Two-layer model from the course notes:
 *
 *   frequency   = "Search Frequency DB"  (query -> count). The SOURCE OF TRUTH.
 *                   - query_lower   : lowercased match key (carries the index used by
 *                                     the >20-char range-scan fallback).
 *                   - query_display : original casing, shown in the UI.
 *                   - count         : aggregated popularity (Wikimedia n, summed).
 *
 *   suggestions = "Top Suggestions DB"   (prefix -> top-k). The PRECOMPUTED layer
 *                 ("data-augmentation == cache"). One row per distinct prefix of
 *                 length 3..20.
 *                   - prefix : lowercased prefix (PRIMARY-KEY-equivalent unique index).
 *                   - top_k  : JSON array of up to 10 {query_display, count}, count desc.
 *
 * Reads are O(1) key fetches on `suggestions`; only prefixes >20 chars fall back to a
 * range scan on `frequency`. See CLAUDE.md / DESIGN.md §1 (eager precompute).
 */
export const DB_PATH = process.env.DB_PATH ?? "data/typeahead.db";

export function openDb(path: string = DB_PATH): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db;
}
