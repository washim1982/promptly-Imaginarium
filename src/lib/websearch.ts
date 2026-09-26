// Web search setup (Settings → Web search) and the desktop search client.
//
// The API key lives in the main process, encrypted with safeStorage. Nothing
// here ever holds it after the save call returns — `status.masked` is all the
// renderer gets back.

import { desktop, requireDesktop } from './desktop';
import type { SearchResult } from './search';

export type SearchProvider = 'keenable' | 'tavily';

export interface SearchStatus {
  configured: boolean;
  keenableSource: 'env' | 'saved' | null;
  keenableMasked: string;
  provider: SearchProvider | null;
  source: 'env' | 'saved' | null;
  masked: string;
  canPersist: boolean;
  fallbackUrl: string;
}

interface SearchBridge {
  status(): Promise<SearchStatus>;
  saveKey(key: string, provider?: SearchProvider): Promise<SearchStatus>;
  clearKey(provider?: SearchProvider): Promise<SearchStatus>;
  verifyKey(key: string, provider?: SearchProvider): Promise<{ ok: true; sample: string }>;
  query(query: string, maxResults?: number): Promise<SearchResult[]>;
}

const bridge = () => (requireDesktop() as unknown as { search: SearchBridge }).search;

/** Undefined in a plain browser build, where search goes through /api/search. */
export const hasSearchBridge = (): boolean =>
  Boolean((desktop as unknown as { search?: SearchBridge } | undefined)?.search);

export const searchApi = {
  status: () => bridge().status(),
  saveKey: (key: string, provider?: SearchProvider) => bridge().saveKey(key, provider),
  clearKey: (provider?: SearchProvider) => bridge().clearKey(provider),
  verifyKey: (key: string, provider?: SearchProvider) => bridge().verifyKey(key, provider),
  query: (query: string, maxResults?: number) => bridge().query(query, maxResults),
};

/** How Settings describes the backend a search would use right now. */
export function describeProvider(status: SearchStatus | null): string {
  if (!status) return 'Checking…';
  return `Keenable (${status.keenableSource ? status.keenableMasked : 'keyless'}) · ${status.source ? 'Tavily fallback ' + status.masked : 'Tavily fallback not configured'}`;
}
