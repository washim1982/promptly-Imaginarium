// IPC for the chat sidebar's Google sections. The renderer can ask for status,
// start/cancel sign-in, and read mail/files; it never receives a token.

import { ipcMain } from 'electron';
import * as auth from './auth';
import * as gmail from './gmail';
import * as drive from './drive';

export function registerGoogleIpc(): void {
  ipcMain.handle('google:status', () => auth.status());
  ipcMain.handle('google:saveClient', async (_e, input: { clientId?: string; clientSecret?: string }) => {
    await auth.saveClient(input);
    return auth.status();
  });
  ipcMain.handle('google:clearClient', async () => {
    await auth.clearClient();
    return auth.status();
  });
  ipcMain.handle('google:connect', () => auth.connect());
  ipcMain.handle('google:cancelConnect', () => auth.cancelConnect());
  ipcMain.handle('google:disconnect', () => auth.disconnect());

  ipcMain.handle('gmail:list', (_e, query: string, pageToken?: string) =>
    gmail.listMessages(String(query ?? ''), pageToken ? String(pageToken) : undefined),
  );
  ipcMain.handle('gmail:get', (_e, id: string) => gmail.getMessage(String(id)));

  ipcMain.handle('drive:list', (_e, search: string, folderId?: string, pageToken?: string) =>
    drive.listFiles(String(search ?? ''), folderId || undefined, pageToken ? String(pageToken) : undefined),
  );
  ipcMain.handle('drive:get', (_e, id: string) => drive.getFileContent(String(id)));
}
