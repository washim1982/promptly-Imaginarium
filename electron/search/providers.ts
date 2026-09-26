export interface SearchResult { title: string; url: string; content: string }
type Request = (url: string, init: { method: string; headers: Record<string, string>; body: string; timeoutMs: number; retries: number }) => Promise<Response>;

export function normalizeResults(data: unknown, limit: number): SearchResult[] {
  const rows = (data as { results?: unknown[] })?.results;
  if (!Array.isArray(rows)) throw new Error('Search returned an invalid response.');
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const r = row as Record<string, unknown>;
    const url = String(r.url ?? '');
    if (!/^https?:\/\//i.test(url) || !r.title) return [];
    return [{ title: String(r.title), url, content: String(r.snippet || r.content || r.description || '').replace(/\s+/g, ' ').trim().slice(0, 1500) }];
  }).slice(0, limit);
}

/** Shared by Electron and the browser development server; credentials stay server-side. */
export async function searchProviders(request: Request, query: string, limit: number, keenableKey?: string, tavilyKey?: string): Promise<SearchResult[]> {
  let primaryError: unknown;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Keenable-Title': 'OMNI-STUDIO' };
    if (keenableKey) headers['X-API-Key'] = keenableKey;
    const response = await request(`https://api.keenable.ai/v1/search${keenableKey ? '' : '/public'}`, {
      method: 'POST', headers, body: JSON.stringify({ query, max_results: limit }), timeoutMs: 20_000, retries: 0,
    });
    if (!response.ok) throw new Error(`Keenable returned HTTP ${response.status}.`);
    const results = normalizeResults(await response.json(), limit);
    if (results.length || !tavilyKey) return results;
    primaryError = new Error('Keenable returned no usable results.');
  } catch (error) { primaryError = error; }
  if (!tavilyKey) throw new Error(`${(primaryError as Error).message} Add a Tavily fallback key in Settings → Web search.`);
  try {
    const response = await request('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tavilyKey}` },
      body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', topic: 'general' }), timeoutMs: 20_000, retries: 0,
    });
    if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}.`);
    return normalizeResults(await response.json(), limit);
  } catch (error) { throw new Error(`Keenable unavailable; Tavily fallback failed. ${(error as Error).message}`); }
}
