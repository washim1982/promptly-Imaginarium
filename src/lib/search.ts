// Web search client. POSTs to a SAME-ORIGIN /api/search endpoint that the server
// (nginx in prod, Vite proxy in dev) reverse-proxies to a self-hosted OrioSearch
// API (Tavily-compatible, backed by SearXNG with result reranking). Same-origin
// keeps it CORS/COEP-safe for the cross-origin-isolated page.

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export async function webSearch(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  // In the desktop app the main process owns search: it holds the Tavily key
  // and calls out through Chromium's network stack, which works behind a
  // corporate proxy. Only the browser build falls through to /api/search.
  const { hasSearchBridge, searchApi } = await import('./websearch');
  if (hasSearchBridge()) return searchApi.query(query, 12);
  // OrioSearch's Tavily-compatible API: POST a JSON body. It aggregates SearXNG's
  // default engine set (DuckDuckGo + others) and reranks for relevance. `basic`
  // depth returns snippets only (fast); no full-page extraction needed here.
  const res = await fetch('/api/search', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      topic: 'general',
      max_results: 12,
    }),
  });
  if (!res.ok) {
    throw new Error(`Web search failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const results: unknown[] = Array.isArray(data?.results) ? data.results : [];
  return results
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o.title ?? '').trim(),
        url: String(o.url ?? '').trim(),
        content: String(o.content ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300),
      };
    })
    .filter((r) => r.title && r.url)
    .slice(0, 12);
}

// Fetch REAL page content for a set of URLs via OrioSearch's /extract endpoint
// (same-origin /api/extract -> OrioSearch POST /extract). Used by Deep Research
// to verify claims against actual source text instead of trusting snippets.
export interface ExtractResult {
  url: string;
  content: string;
}

export async function webExtract(
  urls: string[],
  signal?: AbortSignal,
): Promise<ExtractResult[]> {
  const res = await fetch('/api/extract', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ urls: urls.slice(0, 5), format: 'text' }),
  });
  if (!res.ok) {
    throw new Error(`Content extraction failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const results: unknown[] = Array.isArray(data?.results) ? data.results : [];
  return results
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        url: String(o.url ?? '').trim(),
        content: String(o.raw_content ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
      };
    })
    .filter((r) => r.url && r.content);
}

// Ground a single chat answer in web results: gives the model the sources and
// asks it to answer up-to-date with inline [n] citations + a Sources list.
export function formatSearchForChat(
  results: SearchResult[],
  query: string,
): string {
  if (!results.length) return '';
  const lines = results.map(
    (r, i) =>
      `[${i + 1}] ${r.title} — ${domainOf(r.url)}\n    ${r.url}\n    ${r.content}`,
  );
  return `Web search results for the user's question "${query}" (via OrioSearch). Use them to answer accurately and with current information. Cite sources inline as [n] matching the list below, and finish with a "Sources" section listing the [n] URLs you actually used. If the results don't cover the question, say so briefly and answer from your own knowledge.

Web results:
${lines.join('\n\n')}

---
User question: ${query}`;
}

// Format a batch of NEW sources as a prompt block for the Research Agent.
export function formatSearchForPrompt(
  results: SearchResult[],
  focus: string,
): string {
  if (!results.length) return '';
  const lines = results.map(
    (r, i) =>
      `[${i + 1}] ${r.title} — ${domainOf(r.url)}\n    ${r.url}\n    ${r.content}`,
  );
  return `NEW web sources${focus ? ` (focus: ${focus})` : ''}, via OrioSearch — not seen in earlier iterations:\n${lines.join('\n\n')}`;
}
