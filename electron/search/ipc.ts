// IPC for web search setup and queries. The API key never crosses to the
// renderer — only its masked form, and the results.

import { ipcMain } from 'electron';
import * as search from './tavily';

export function registerSearchIpc(): void {
  ipcMain.handle('search:status', () => search.status());

  ipcMain.handle('search:saveKey', async (_e, key: string, provider?: search.SearchProvider) => search.saveKey(key, provider));

  ipcMain.handle('search:clearKey', async (_e, provider?: search.SearchProvider) => search.clearKey(provider));

  ipcMain.handle('search:verifyKey', async (_e, key: string, provider?: search.SearchProvider) => search.verifyKey(key, provider));

  ipcMain.handle('search:query', async (_e, query: string, maxResults?: number) =>
    search.search(String(query ?? ''), typeof maxResults === 'number' ? maxResults : 8),
  );
}
