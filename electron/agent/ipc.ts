// IPC surface for the chat agent's tools. The workspace root lives here in
// the main process, chosen only through a native folder picker — the model
// never supplies a root, only paths relative to it.

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as tools from './tools';

const settingsFile = () => path.join(app.getPath('userData'), 'agent-settings.json');

async function getWorkspace(): Promise<string | null> {
  try {
    const { workspace } = JSON.parse(await readFile(settingsFile(), 'utf8')) as { workspace?: string };
    if (!workspace) return null;
    const st = await stat(workspace).catch(() => null);
    return st?.isDirectory() ? workspace : null; // folder moved or deleted
  } catch {
    return null;
  }
}

async function setWorkspace(workspace: string | null): Promise<void> {
  await mkdir(path.dirname(settingsFile()), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify({ workspace }, null, 2), 'utf8');
}

async function requireWorkspace(): Promise<string> {
  const ws = await getWorkspace();
  if (!ws) {
    throw new Error(
      'No workspace folder is set, so file tools are unavailable. Ask the user to choose one with the workspace button next to Agent.',
    );
  }
  return ws;
}

const describe = (ws: string | null) => (ws ? { path: ws, name: path.basename(ws) || ws } : null);

export function registerAgentIpc(): void {
  ipcMain.handle('agent:getWorkspace', async () => describe(await getWorkspace()));

  ipcMain.handle('agent:pickWorkspace', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, {
      title: 'Choose the folder the agent may work in',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePaths[0]) return describe(await getWorkspace());
    await setWorkspace(r.filePaths[0]);
    return describe(r.filePaths[0]);
  });

  ipcMain.handle('agent:clearWorkspace', async () => {
    await setWorkspace(null);
    return null;
  });

  ipcMain.handle('agent:listDir', async (_e, rel: string) => tools.listDir(await requireWorkspace(), String(rel ?? '.')));
  ipcMain.handle('agent:readFile', async (_e, rel: string, start?: number, end?: number) =>
    tools.readTextFile(await requireWorkspace(), String(rel ?? ''), start, end),
  );
  ipcMain.handle('agent:searchFiles', async (_e, pattern: string, glob?: string) =>
    tools.searchFiles(await requireWorkspace(), String(pattern ?? ''), glob ? String(glob) : undefined),
  );
  ipcMain.handle('agent:writeFile', async (_e, rel: string, content: string) =>
    tools.writeTextFile(await requireWorkspace(), String(rel ?? ''), String(content ?? '')),
  );
  ipcMain.handle('agent:runCommand', async (_e, command: string) =>
    tools.runCommand(await requireWorkspace(), String(command ?? '')),
  );
  ipcMain.handle('agent:fetchUrl', async (_e, url: string) => tools.fetchUrl(String(url ?? '')));
}
