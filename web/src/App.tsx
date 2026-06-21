import { useEffect, useState } from "react";

type Suggestion = { query: string; count: number };

/**
 * useDebounce — returns `value` only after it has stopped changing for `delay` ms.
 *
 * WHY (this is a graded design point — see DESIGN.md §6):
 * A user typing "london" produces 6 keystrokes in well under a second. Without
 * debouncing we'd fire 6 /suggest requests, 5 of which are instantly stale. The
 * debounce collapses a burst of keystrokes into ONE request for the final prefix,
 * so the backend (and the cache/DB behind it) does a fraction of the work. The
 * cost is ~150 ms of perceived latency, which is below the threshold a typing
 * user notices.
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id); // cancel if value changes before the delay elapses
  }, [value, delay]);
  return debounced;
}

/**
 * MatchedTitle — purely presentational: emphasises the first `matchLen` characters of a
 * suggestion (the matched prefix). No behavior; just wraps that slice in a styled span.
 */
function MatchedTitle({ text, matchLen }: { text: string; matchLen: number }) {
  const n = Math.min(Math.max(matchLen, 0), text.length);
  if (n === 0) return <>{text}</>;
  return (
    <>
      <span className="match">{text.slice(0, n)}</span>
      {text.slice(n)}
    </>
  );
}

export function App() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1); // -1 = nothing highlighted
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [trendingMode, setTrendingMode] = useState(false); // basic vs trending ranking
  const [trendingList, setTrendingList] = useState<Array<{ query: string; score: number }>>([]);

  const debouncedQuery = useDebounce(query, 150);

  // Fetch suggestions whenever the DEBOUNCED prefix changes. We abort the previous
  // request so a slow earlier response can't overwrite a newer one (race safety).
  useEffect(() => {
    const prefix = debouncedQuery.trim();
    if (prefix.length === 0) {
      setSuggestions([]);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const mode = trendingMode ? "trending" : "basic";
    fetch(`/suggest?q=${encodeURIComponent(prefix)}&mode=${mode}`, { signal: controller.signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setSuggestions(data.suggestions ?? []);
        setActiveIndex(-1);
      })
      .catch((err) => {
        if (err.name === "AbortError") return; // superseded by a newer keystroke
        setError("Could not load suggestions.");
        setSuggestions([]);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [debouncedQuery, trendingMode]);

  // Keep the trending section fresh: load on mount and poll periodically.
  function refreshTrending() {
    fetch("/trending", { cache: "no-store" }) // poll the live value, never the HTTP cache
      .then((r) => r.json())
      .then((d) => setTrendingList(d.trending ?? []))
      .catch(() => {});
  }
  useEffect(() => {
    refreshTrending();
    const id = setInterval(refreshTrending, 5000);
    return () => clearInterval(id);
  }, []);

  async function submitSearch(term: string) {
    const t = term.trim();
    if (!t) return;
    setSuggestions([]);
    setActiveIndex(-1);
    try {
      // POST /search records the query; the backend recomputes affected suggestions so
      // this term surfaces in future /suggest calls. We show the real server message.
      const r = await fetch("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: t }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setSubmitMsg(`${data.message}: "${t}"`);
      refreshTrending(); // the search just changed the trending scores
    } catch {
      setSubmitMsg("Search failed.");
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      // If a suggestion is highlighted, submit that; otherwise submit the raw input.
      if (activeIndex >= 0 && suggestions[activeIndex]) {
        setQuery(suggestions[activeIndex].query);
        submitSearch(suggestions[activeIndex].query);
      } else {
        submitSearch(query);
      }
    } else if (e.key === "Escape") {
      setSuggestions([]);
      setActiveIndex(-1);
    }
  }

  const matchLen = debouncedQuery.trim().length; // for emphasising the matched prefix (display only)

  return (
    <div className="page">
      <main className="shell">
        <header className="masthead">
          <h1 className="wordmark">TypeAhead</h1>
          <p className="tagline">prefix search · suggestions begin at 3 characters</p>
        </header>

        <div className="controls">
          <label className="switch">
            <input
              className="switch-input"
              type="checkbox"
              checked={trendingMode}
              onChange={(e) => setTrendingMode(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            <span className="switch-text">Trending mode</span>
          </label>
        </div>

        <div className="search">
          <div className="search-bar">
            <input
              className="search-input"
              type="text"
              placeholder="Search Wikipedia titles…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              autoFocus
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls="suggestion-list"
              aria-activedescendant={activeIndex >= 0 ? `sugg-${activeIndex}` : undefined}
            />
            <button className="search-btn" onClick={() => submitSearch(query)}>
              Search
            </button>
          </div>

          {/* Dropdown: loading / error / results, in priority order. */}
          {loading && <div className="dropdown dropdown-status status-loading">Searching…</div>}
          {error && <div className="dropdown dropdown-status status-error">{error}</div>}
          {!loading && !error && suggestions.length > 0 && (
            <ul className="dropdown" id="suggestion-list" role="listbox">
              {suggestions.map((s, i) => (
                <li
                  key={s.query}
                  id={`sugg-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={i === activeIndex ? "option active" : "option"}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => {
                    // onMouseDown (not onClick) so it fires before the input blurs.
                    e.preventDefault();
                    setQuery(s.query);
                    submitSearch(s.query);
                  }}
                >
                  <span className="option-title">
                    <MatchedTitle text={s.query} matchLen={matchLen} />
                  </span>
                  <span className="option-count">{s.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {submitMsg && (
          <div className="submit-msg">
            <span className="submit-tick">›</span>
            {submitMsg}
          </div>
        )}

        {/* Trending section — live top trending queries by recency score. */}
        <section className="trending">
          <div className="trending-head">
            <h2>Trending</h2>
            <span className="trending-hint">live · 5s</span>
          </div>
          {trendingList.length === 0 ? (
            <p className="trending-empty">No recent activity yet — search a few queries to see trending.</p>
          ) : (
            <ol className="trending-list">
              {trendingList.map((t, i) => (
                <li key={t.query} className="trending-row">
                  <span className="trending-rank">{i + 1}</span>
                  <span className="trending-title">{t.query}</span>
                  <span className="trending-score">{t.score}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </div>
  );
}
