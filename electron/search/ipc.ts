// IPC for web search setup and queries. The API key never crosses to the
// renderer — only its masked form, and the results.

import { ipcMain } from 'electron';
import * as search from './tavily';

export function registerSearchIpc(): void {
  ipcMain.handle('search:status', () => search.status());

  ipcMain.handle('search:saveKey', async (_e, key: string) => search.saveKey(key));

  ipcMain.handle('search:clearKey', async () => search.clearKey());

  ipcMain.handle('search:verifyKey', async (_e, key: string) => search.verifyKey(key));

  ipcMain.handle('search:query', async (_e, query: string, maxResults?: number) =>
    search.search(String(query ?? ''), typeof maxResults === 'number' ? maxResults : 8),
  );
}
