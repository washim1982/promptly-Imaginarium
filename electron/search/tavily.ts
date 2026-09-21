// Web search for the chat and the agent's web_search tool.
//
// Two backends, in order: a Tavily API key the user pastes into Settings, or
// the self-hosted OrioSearch at ORIOSEARCH_URL. Tavily is what makes search
// work on a machine with nothing self-hosted.
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

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export type SearchProvider = 'tavily' | 'oriosearch';

export interface SearchStatus {
  /** A usable backend exists (a Tavily key, or OrioSearch is configured). */
  configured: boolean;
  provider: SearchProvider | null;
  /** Where the Tavily key came from, if there is one. */
  source: 'env' | 'saved' | null;
  /** "tvly-…a1b2" — enough to recognise the key, not enough to use it. */
  masked: string;
  /** False on a machine without DPAPI: the key then lives for this run only. */
  canPersist: boolean;
  /** The OrioSearch base URL, shown as the fallback in Settings. */
  fallbackUrl: string;
}

const keyFile = () => path.join(app.getPath('userData'), 'search-key.bin');

const ORIOSEARCH_URL = process.env.ORIOSEARCH_URL ?? 'http://localhost:8005';
const TAVILY_URL = 'https://api.tavily.com/search';

/** Key held in memory when safeStorage can't persist it (no DPAPI). */
let volatileKey: string | null = null;

// ---- the key ---------------------------------------------------------------------------

/** Tavily keys look like "tvly-…" or "tvly-dev-…". */
export function validateKey(raw: unknown): string {
  const key = String(raw ?? '').trim();
  if (!key) throw new Error('Paste your Tavily API key.');
  if (/\s/.test(key)) throw new Error('That looks like more than just the key — paste the key on its own.');
  if (!/^tvly-[A-Za-z0-9_-]{8,}$/i.test(key)) {
    throw new Error('A Tavily key starts with "tvly-". Copy it from app.tavily.com → API Keys.');
  }
  return key;
}

export function maskKey(key: string): string {
  return key.length <= 12 ? 'tvly-…' : `${key.slice(0, 9)}…${key.slice(-4)}`;
}

async function loadKey(): Promise<{ key: string; source: 'env' | 'saved' } | null> {
  const fromEnv = process.env.TAVILY_API_KEY?.trim();
  if (fromEnv) {
    try {
      return { key: validateKey(fromEnv), source: 'env' };
    } catch {
      /* a malformed env var shouldn't hide a good saved key */
    }
  }
  if (volatileKey) return { key: volatileKey, source: 'saved' };
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return { key: safeStorage.decryptString(await readFile(keyFile())), source: 'saved' };
  } catch {
    return null; // not set yet, or encrypted for a different Windows user
  }
}

export async function saveKey(raw: unknown): Promise<SearchStatus> {
  const key = validateKey(raw);
  if (safeStorage.isEncryptionAvailable()) {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(keyFile(), safeStorage.encryptString(key));
    volatileKey = null;
  } else {
    volatileKey = key; // this run only — never plain text on disk
  }
  return status();
}

export async function clearKey(): Promise<SearchStatus> {
  volatileKey = null;
  await rm(keyFile(), { force: true });
  return status();
}

export async function status(): Promise<SearchStatus> {
  const loaded = await loadKey();
  return {
    configured: Boolean(loaded) || Boolean(ORIOSEARCH_URL),
    provider: loaded ? 'tavily' : ORIOSEARCH_URL ? 'oriosearch' : null,
    source: loaded?.source ?? null,
    masked: loaded ? maskKey(loaded.key) : '',
    canPersist: safeStorage.isEncryptionAvailable(),
    fallbackUrl: ORIOSEARCH_URL,
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

async function searchOrio(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await httpFetch(`${ORIOSEARCH_URL}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, search_depth: 'basic', topic: 'general', max_results: maxResults }),
    timeoutMs: 20_000,
  });
  if (!res.ok) throw new Error(`Search backend at ${ORIOSEARCH_URL} returned HTTP ${res.status}.`);
  return toResults(await res.json(), maxResults);
}

/** Tavily when a key is set, otherwise the self-hosted backend. */
export async function search(query: string, maxResults = 8): Promise<SearchResult[]> {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('Enter something to search for.');
  const limit = Math.min(Math.max(1, Math.floor(maxResults) || 8), 12);
  const loaded = await loadKey();
  if (loaded) return searchTavily(loaded.key, q, limit);
  try {
    return await searchOrio(q, limit);
  } catch (err) {
    throw new Error(
      `No web search is set up. Add a Tavily API key in Settings → Web search. (Local backend: ${(err as Error).message})`,
    );
  }
}

/** Settings' "Test key": confirm a key works before saving it. */
export async function verifyKey(raw: unknown): Promise<{ ok: true; sample: string }> {
  const key = validateKey(raw);
  const results = await searchTavily(key, 'what day is it today', 1);
  return { ok: true, sample: results[0]?.url ?? 'no results, but the key was accepted' };
}
