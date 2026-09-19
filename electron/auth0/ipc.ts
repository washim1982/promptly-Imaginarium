// IPC for the optional Auth0 login. The renderer gets status and the user's
// profile; tokens never leave the main process.

import { ipcMain } from 'electron';
import * as auth0 from './auth';

export function registerAuth0Ipc(): void {
  ipcMain.handle('auth0:status', () => auth0.status());
  ipcMain.handle('auth0:verify', () => auth0.verifySession());
  ipcMain.handle('auth0:saveClient', async (_e, input: { domain?: string; clientId?: string }) => {
    await auth0.saveClient(input);
    return auth0.status();
  });
  ipcMain.handle('auth0:clearClient', async () => {
    await auth0.clearClient();
    return auth0.status();
  });
  ipcMain.handle('auth0:login', () => auth0.login());
  ipcMain.handle('auth0:cancelLogin', () => auth0.cancelLogin());
  ipcMain.handle('auth0:logout', () => auth0.logout());
}
