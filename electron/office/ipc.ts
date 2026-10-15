// IPC for the MS-Studio tab.
//
// Everything is confined to one folder the user picked in a native dialog —
// the same rule the agent's file tools follow. The renderer only ever sends
// paths relative to that root.

import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeRelativePath } from '../svn/pathSafety';
import {
  buildTree,
  createDocument,
  createWorkbook,
  extractText,
  kindOf,
  readBytes,
  readSlides,
  readWorkbook,
  writeWorkbookEdits,
  type CellEdit,
} from './documents';

const settingsFile = () => path.join(app.getPath('userData'), 'office-workspace.json');

async function getRoot(): Promise<string | null> {
  try {
    const { root } = JSON.parse(await readFile(settingsFile(), 'utf8')) as { root?: string };
    if (!root) return null;
    return (await stat(root).catch(() => null))?.isDirectory() ? root : null;
  } catch {
    return null;
  }
}

async function setRoot(root: string | null): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify({ root }, null, 2), 'utf8');
}

async function requireRoot(): Promise<string> {
  const root = await getRoot();
  if (!root) throw new Error('Choose a documents folder first.');
  return root;
}

/** Resolve a renderer-supplied relative path inside the chosen folder. */
async function resolve(rel: string): Promise<string> {
  const root = await requireRoot();
  return path.resolve(root, assertSafeRelativePath(root, String(rel ?? '')));
}

const describe = (root: string | null) => (root ? { path: root, name: path.basename(root) || root } : null);

export function registerOfficeIpc(): void {
  ipcMain.handle('office:getWorkspace', async () => describe(await getRoot()));

  ipcMain.handle('office:pickWorkspace', async (e: IpcMainInvokeEvent) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, {
      title: 'Choose a documents folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePaths[0]) return describe(await getRoot());
    await setRoot(r.filePaths[0]);
    return describe(r.filePaths[0]);
  });

  ipcMain.handle('office:tree', async () => buildTree(await requireRoot()));

  ipcMain.handle('office:readWorkbook', async (_e, rel: string) => readWorkbook(await resolve(rel)));

  ipcMain.handle('office:saveWorkbook', async (_e, rel: string, edits: CellEdit[]) => {
    const applied = await writeWorkbookEdits(await resolve(rel), Array.isArray(edits) ? edits : []);
    return { applied };
  });

  ipcMain.handle('office:extractText', async (_e, rel: string, maxChars?: number) =>
    extractText(await resolve(rel), typeof maxChars === 'number' ? maxChars : 20000),
  );

  ipcMain.handle('office:readSlides', async (_e, rel: string) => readSlides(await resolve(rel)));

  // docx-preview runs in the renderer, so it needs the bytes.
  ipcMain.handle('office:readBytes', async (_e, rel: string) => readBytes(await resolve(rel)));

  ipcMain.handle('office:create', async (_e, rel: string) => {
    const file = await resolve(rel);
    const kind = kindOf(file);
    if (kind === 'sheet') await createWorkbook(file);
    else if (kind === 'word') await createDocument(file);
    else throw new Error('New presentations are not supported yet — create a .xlsx or .docx.');
    return { path: path.basename(file) };
  });

  ipcMain.handle('office:reveal', async (_e, rel: string) => {
    shell.showItemInFolder(await resolve(rel));
  });
}
