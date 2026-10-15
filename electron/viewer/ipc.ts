// File Viewer tab: open a file the user picked and hand its text to the
// renderer.
//
// The renderer never names an arbitrary path. A path becomes readable only
// after the user chose it here — through the native dialog, or by dropping it
// on the window — and the set is kept in the main process. That way a bug in
// the renderer can't turn this channel into "read any file on the disk".

import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Bigger than this and it isn't a document someone wants to read in a pane. */
const MAX_BYTES = 8_000_000;

export interface FileRef {
  path: string;
  name: string;
  size: number;
}

export interface FileContents extends FileRef {
  text: string;
  /** True when the file was cut short at MAX_BYTES. */
  truncated: boolean;
}

/** Paths the user has opened this session, and may therefore read. */
const allowed = new Set<string>();

const windowOf = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)!;

/** Record a path the user chose, and describe it. Exported for the tests. */
export async function acceptPath(file: string): Promise<FileRef | null> {
  return describe(file);
}

/** Forget every allowed path. Test helper; the set is per-session otherwise. */
export function resetAllowed(): void {
  allowed.clear();
}

async function describe(file: string): Promise<FileRef | null> {
  const resolved = path.resolve(file);
  const st = await stat(resolved).catch(() => null);
  if (!st?.isFile()) return null;
  allowed.add(resolved);
  return { path: resolved, name: path.basename(resolved), size: st.size };
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

/**
 * Read a file the user opened earlier. Refuses anything not in `allowed`,
 * which is the whole point of the channel: the renderer cannot name a path of
 * its own choosing and have it read.
 */
export async function readAllowed(file: string): Promise<FileContents> {
  const resolved = path.resolve(file);
  if (!allowed.has(resolved)) {
    throw new Error('That file was not opened in this session. Use Open files, or drop it on the window.');
  }
  const st = await stat(resolved).catch(() => null);
  if (!st?.isFile()) throw new Error('That file no longer exists.');
  const buf = await readFile(resolved);
  if (looksBinary(buf)) {
    throw new Error(`${path.basename(resolved)} looks like a binary file, so there is nothing to show.`);
  }
  const truncated = buf.length > MAX_BYTES;
  return {
    path: resolved,
    name: path.basename(resolved),
    size: st.size,
    text: (truncated ? buf.subarray(0, MAX_BYTES) : buf).toString('utf8'),
    truncated,
  };
}

export function registerViewerIpc(): void {
  ipcMain.handle('viewer:pick', async (e) => {
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: 'Open files to view',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Text, code and documents', extensions: ['md', 'markdown', 'txt', 'html', 'htm', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'less', 'py', 'java', 'cs', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'sh', 'ps1', 'yml', 'yaml', 'toml', 'ini', 'xml', 'sql', 'csv', 'log'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (r.canceled) return [];
    const refs = await Promise.all(r.filePaths.map(describe));
    return refs.filter((f): f is FileRef => f !== null);
  });

  // Files dropped on the window. webUtils.getPathForFile in the preload turns
  // the drop into a real path; the drop itself is the user's choice to open it.
  ipcMain.handle('viewer:accept', async (_e, paths: string[]) => {
    const list = Array.isArray(paths) ? paths.map(String).slice(0, 50) : [];
    const refs = await Promise.all(list.map(describe));
    return refs.filter((f): f is FileRef => f !== null);
  });

  ipcMain.handle('viewer:read', async (_e, file: string) => readAllowed(String(file ?? '')));

  ipcMain.handle('viewer:reveal', async (_e, file: string) => {
    const resolved = path.resolve(String(file ?? ''));
    if (!allowed.has(resolved)) return;
    shell.showItemInFolder(resolved);
  });

  // Opening the workspace or a repository is a common way in, so the renderer
  // can ask for the folders the rest of the app already knows about.
  ipcMain.handle('viewer:home', () => app.getPath('documents'));
}
