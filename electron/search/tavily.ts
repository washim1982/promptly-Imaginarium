// Web search for the chat and the agent's web_search tool.
//
// Keenable is the default; a saved Tavily key enables automatic fallback.
//
// Everything goes through httpFetch (Electron's net.fetch — Chromium's network
// stack), never Node's fetch: behind a corporate proxy or a TLS-inspecting
// gateway Node's fetch ignores the Windows proxy configuration and the Windows
// certificate store, and fails with a bare "TypeError: fetch failed".
//
// The key is held here in the main process, encrypted at rest with safeStorage
// (DPAPI on Windows). The renderer only ever sees a masked form of it.

import { app, safeStorage } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { httpFetch } from '../oauth/http';
import { normalizeResults, searchProviders } from './providers';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export type SearchProvider = 'keenable' | 'tavily';

export interface SearchStatus {
  /** Keenable's public endpoint is available without configuration. */
  configured: boolean;
  keenableSource: 'env' | 'saved' | null;
  keenableMasked: string;
  provider: SearchProvider | null;
  /** Where the Tavily key came from, if there is one. */
  source: 'env' | 'saved' | null;
  /** "tvly-…a1b2" — enough to recognise the key, not enough to use it. */
  masked: string;
  /** False on a machine without DPAPI: the key then lives for this run only. */
  canPersist: boolean;
  /** Tavily fallback endpoint. */
  fallbackUrl: string;
}

const keyFile = (provider: SearchProvider) => path.join(app.getPath('userData'), provider === 'keenable' ? 'keenable-key.bin' : 'search-key.bin');
function checkProvider(provider: SearchProvider): void {
  if (provider !== 'keenable' && provider !== 'tavily') throw new Error('Unknown search provider.');
}

const TAVILY_URL = 'https://api.tavily.com/search';

/** Key held in memory when safeStorage can't persist it (no DPAPI). */
const volatileKeys: Partial<Record<SearchProvider, string>> = {};

// ---- the key ---------------------------------------------------------------------------

/** Tavily keys look like "tvly-…" or "tvly-dev-…". */
export function validateKey(raw: unknown, provider: SearchProvider = 'tavily'): string {
  checkProvider(provider);
  const key = String(raw ?? '').trim();
  if (!key) throw new Error(`Paste your ${provider === 'keenable' ? 'Keenable' : 'Tavily'} API key.`);
  if (/\s/.test(key)) throw new Error('That looks like more than just the key — paste the key on its own.');
  if (provider === 'keenable') {
    if (key.length < 8 || key.length > 4096) throw new Error('Paste the complete Keenable API key from app.keenable.ai.');
    return key;
  }
  if (!/^tvly-[A-Za-z0-9_-]{8,}$/i.test(key)) {
    throw new Error('A Tavily key starts with "tvly-". Copy it from app.tavily.com → API Keys.');
  }
  return key;
}

export function maskKey(key: string): string {
  return key.length <= 12 ? '••••••••' : `${key.slice(0, 9)}…${key.slice(-4)}`;
}

async function loadKey(provider: SearchProvider = 'tavily'): Promise<{ key: string; source: 'env' | 'saved' } | null> {
  checkProvider(provider);
  const fromEnv = (provider === 'keenable' ? process.env.KEENABLE_API_KEY : process.env.TAVILY_API_KEY)?.trim();
  if (fromEnv) {
    try {
      return { key: validateKey(fromEnv, provider), source: 'env' };
    } catch {
      /* a malformed env var shouldn't hide a good saved key */
    }
  }
  if (volatileKeys[provider]) return { key: volatileKeys[provider]!, source: 'saved' };
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return { key: safeStorage.decryptString(await readFile(keyFile(provider))), source: 'saved' };
  } catch {
    return null; // not set yet, or encrypted for a different Windows user
  }
}

export async function saveKey(raw: unknown, provider: SearchProvider = 'tavily'): Promise<SearchStatus> {
  const key = validateKey(raw, provider);
  if (safeStorage.isEncryptionAvailable()) {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(keyFile(provider), safeStorage.encryptString(key));
    delete volatileKeys[provider];
  } else {
    volatileKeys[provider] = key; // this run only — never plain text on disk
  }
  return status();
}

export async function clearKey(provider: SearchProvider = 'tavily'): Promise<SearchStatus> {
  checkProvider(provider);
  delete volatileKeys[provider];
  await rm(keyFile(provider), { force: true });
  return status();
}

export async function status(): Promise<SearchStatus> {
  const loaded = await loadKey();
  const keenable = await loadKey('keenable');
  return {
    keenableSource: keenable?.source ?? null,
    keenableMasked: keenable ? maskKey(keenable.key) : '',
    configured: true,
    provider: 'keenable',
    source: loaded?.source ?? null,
    masked: loaded ? maskKey(loaded.key) : '',
    canPersist: safeStorage.isEncryptionAvailable(),
    fallbackUrl: 'https://api.tavily.com/search',
  };
}

// ---- searching -------------------------------------------------------------------------

function toResults(raw: unknown, limit: number): SearchResult[] {
  const rows: unknown[] = Array.isArray((raw as { results?: unknown[] })?.results)
    ? (raw as { results: unknown[] }).results
    : [];
  return rows
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o.title ?? '').trim(),
        url: String(o.url ?? '').trim(),
        content: String(o.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    })
    .filter((r) => r.title && r.url)
    .slice(0, limit);
}

/** Turn Tavily's HTTP errors into something a user can act on. */
function tavilyError(statusCode: number, body: string): Error {
  if (statusCode === 401) return new Error('Tavily rejected the API key. Check it in Settings → Web search.');
  if (statusCode === 429) return new Error('Tavily rate limit reached. Wait a moment, or check your plan usage.');
  if (statusCode === 432 || statusCode === 433) {
    return new Error('Your Tavily plan is out of credits for this period.');
  }
  const detail = body.slice(0, 200).replace(/\s+/g, ' ').trim();
  return new Error(`Tavily search failed (HTTP ${statusCode})${detail ? `: ${detail}` : ''}.`);
}

async function searchTavily(key: string, query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await httpFetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, search_depth: 'basic', topic: 'general', max_results: maxResults }),
    timeoutMs: 20_000,
  });
  if (!res.ok) throw tavilyError(res.status, await res.text().catch(() => ''));
  return toResults(await res.json(), maxResults);
}

/** Keenable first, with the existing encrypted Tavily key as fallback. */
export async function search(query: string, maxResults = 8): Promise<SearchResult[]> {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('Enter something to search for.');
  const limit = Math.min(Math.max(1, Math.floor(maxResults) || 8), 12);
  const loaded = await loadKey();
  const keenable = await loadKey('keenable');
  return searchProviders(httpFetch, q, limit, keenable?.key, loaded?.key);
}

/** Settings' "Test key": confirm a key works before saving it. */
export async function verifyKey(raw: unknown, provider: SearchProvider = 'tavily'): Promise<{ ok: true; sample: string }> {
  checkProvider(provider);
  const key = String(raw ?? '').trim() ? validateKey(raw, provider) : (await loadKey(provider))?.key;
  if (!key) throw new Error('Add a key before testing.');
  if (provider === 'keenable') {
    // Test only the authenticated endpoint: fallback must never hide a rejected key.
    const res = await httpFetch('https://api.keenable.ai/v1/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ query: 'family travel', max_results: 1 }), timeoutMs: 20_000, retries: 0,
    });
    if (!res.ok) throw new Error(`Keenable key test failed (HTTP ${res.status}). Check the key and account limits.`);
    const results = normalizeResults(await res.json(), 1);
    return { ok: true, sample: results[0]?.url ?? 'Key accepted; no results.' };
  }
  const results = await searchTavily(key, 'what day is it today', 1);
  return { ok: true, sample: results[0]?.url ?? 'no results, but the key was accepted' };
}
