// Web search setup (Settings → Web search) and the desktop search client.
//
// The API key lives in the main process, encrypted with safeStorage. Nothing
// here ever holds it after the save call returns — `status.masked` is all the
// renderer gets back.

import { desktop, requireDesktop } from './desktop';
import type { SearchResult } from './search';

export type SearchProvider = 'tavily' | 'oriosearch';

export interface SearchStatus {
  configured: boolean;
  provider: SearchProvider | null;
  source: 'env' | 'saved' | null;
  masked: string;
  canPersist: boolean;
  fallbackUrl: string;
}

interface SearchBridge {
  status(): Promise<SearchStatus>;
  saveKey(key: string): Promise<SearchStatus>;
  clearKey(): Promise<SearchStatus>;
  verifyKey(key: string): Promise<{ ok: true; sample: string }>;
  query(query: string, maxResults?: number): Promise<SearchResult[]>;
}

const bridge = () => (requireDesktop() as unknown as { search: SearchBridge }).search;

/** Undefined in a plain browser build, where search goes through /api/search. */
export const hasSearchBridge = (): boolean =>
  Boolean((desktop as unknown as { search?: SearchBridge } | undefined)?.search);

export const searchApi = {
  status: () => bridge().status(),
  saveKey: (key: string) => bridge().saveKey(key),
  clearKey: () => bridge().clearKey(),
  verifyKey: (key: string) => bridge().verifyKey(key),
  query: (query: string, maxResults?: number) => bridge().query(query, maxResults),
};

/** How Settings describes the backend a search would use right now. */
export function describeProvider(status: SearchStatus | null): string {
  if (!status) return 'Checking…';
  if (status.provider === 'tavily') {
    return status.source === 'env' ? `Tavily (key from TAVILY_API_KEY)` : `Tavily (${status.masked})`;
  }
  return `Self-hosted backend at ${status.fallbackUrl}`;
}
