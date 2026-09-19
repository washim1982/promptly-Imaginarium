// IPC surface for the SVN Studio tab. Each handler replaces one route from SVN
// Studio's Express server (web/server/src/routes/*.ts); the preload exposes them
// as window.imaginarium.svn.*. Every path from the renderer goes through
// assertSafeRelativePath, exactly as the routes did.

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { assertSafeRelativePath } from './pathSafety';
import * as settingsStore from './settingsStore';
import * as svnService from './svnService';
import { buildAiContext } from './aiContext';
import { detectSvn } from './svnCli';
import type { AiScope, SvnSettings } from './types';

async function requireSettings(): Promise<SvnSettings> {
  const settings = await settingsStore.loadSettings();
  if (!settings?.workingCopyPath) {
    throw new Error('SVN is not configured yet. Open SVN Settings to link a working copy.');
  }
  return settings;
}

const safe = (settings: SvnSettings, p: unknown) =>
  assertSafeRelativePath(settings.workingCopyPath, String(p ?? ''));

const safeList = (settings: SvnSettings, v: unknown) =>
  (Array.isArray(v) ? v : []).map((p) => safe(settings, p));

const windowOf = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)!;

/** Register a handler that needs a configured working copy. */
function withWc<A extends unknown[], R>(
  channel: string,
  fn: (settings: SvnSettings, ...args: A) => Promise<R>,
): void {
  ipcMain.handle(channel, async (_e, ...args: unknown[]) => fn(await requireSettings(), ...(args as A)));
}

export function registerSvnIpc(): void {
  // ---- settings ---------------------------------------------------------------

  ipcMain.handle('svn:getSettings', async () => settingsStore.toPublic(await settingsStore.loadSettings()));

  ipcMain.handle(
    'svn:saveSettings',
    async (
      _e,
      input: { repoUrl: string; username: string; password?: string; workingCopyPath: string; svnPath?: string },
    ) => {
      if (!input?.workingCopyPath) throw new Error('A local working-copy folder is required.');
      const existing = await settingsStore.loadSettings();
      const merged: SvnSettings = {
        repoUrl: input.repoUrl ?? '',
        username: input.username ?? existing?.username ?? '',
        // Blank means "keep the stored password", as in SVN Studio.
        password: input.password || existing?.password || '',
        workingCopyPath: input.workingCopyPath,
        svnPath: input.svnPath ?? existing?.svnPath ?? '',
      };
      await settingsStore.saveSettings(merged);
      return settingsStore.toPublic(merged);
    },
  );

  ipcMain.handle('svn:detect', async (_e, svnPath?: string) => {
    const configured = svnPath ?? (await settingsStore.loadOrDefault()).svnPath;
    return detectSvn(configured);
  });

  ipcMain.handle('svn:checkout', async () => {
    const settings = await settingsStore.loadSettings();
    if (!settings?.repoUrl || !settings.workingCopyPath) {
      throw new Error('Save a repository URL and a local folder first.');
    }
    const result = await svnService.checkout(settings);
    return { output: result.stdout };
  });

  ipcMain.handle('svn:relink', async (_e, workingCopyPath: string) => {
    if (!workingCopyPath) throw new Error('A working-copy folder is required.');
    const existing = await settingsStore.loadOrDefault();
    if (!(await svnService.isWorkingCopy(existing, workingCopyPath))) {
      throw new Error('That folder is not a valid SVN working copy.');
    }
    const merged: SvnSettings = { ...existing, workingCopyPath };
    await settingsStore.saveSettings(merged);
    return settingsStore.toPublic(merged);
  });

  // Native pickers — the web build had to make users type paths.
  ipcMain.handle('svn:browseFolder', async (e, title?: string) => {
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: title ?? 'Choose a working-copy folder',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });

  ipcMain.handle('svn:browseSvnExe', async (e) => {
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: 'Locate svn.exe',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: 'svn executable', extensions: ['exe'] }],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });

  // ---- reads -------------------------------------------------------------------

  withWc('svn:tree', (s) => svnService.getTree(s));
  withWc('svn:status', (s) => svnService.getStatus(s));
  withWc('svn:file', (s, p: string) => svnService.getFileContent(s, safe(s, p)));
  withWc('svn:diff', (s, p: string) => svnService.getDiff(s, safe(s, p)));
  withWc('svn:history', (s, p?: string) => svnService.getLog(s, p ? safe(s, p) : undefined));

  // ---- writes ------------------------------------------------------------------

  withWc('svn:saveFile', (s, p: string, content: string) =>
    svnService.writeFileContent(s, safe(s, p), String(content ?? '')),
  );
  withWc('svn:createFile', (s, p: string) => svnService.createFile(s, safe(s, p)));
  withWc('svn:createFolder', (s, p: string) => svnService.createFolder(s, safe(s, p)));
  withWc('svn:delete', (s, p: string) => svnService.deletePath(s, safe(s, p)));
  withWc('svn:rename', (s, from: string, to: string) =>
    svnService.renamePath(s, safe(s, from), safe(s, to)),
  );

  withWc('svn:commit', async (s, paths: string[], message: string) => {
    if (!String(message ?? '').trim()) throw new Error('A commit message is required.');
    const list = safeList(s, paths);
    if (list.length === 0) throw new Error('Select at least one change to commit.');
    return { output: (await svnService.commit(s, list, message)).stdout };
  });
  withWc('svn:update', async (s) => ({ output: (await svnService.update(s)).stdout }));
  withWc('svn:revert', async (s, paths: string[]) => ({
    output: (await svnService.revert(s, safeList(s, paths))).stdout,
  }));
  withWc('svn:lock', (s, p: string, message?: string) => svnService.lockPath(s, safe(s, p), message));
  withWc('svn:unlock', (s, p: string) => svnService.unlockPath(s, safe(s, p)));

  // ---- import (replaces the multipart /svn/upload route) --------------------------

  ipcMain.handle('svn:uploadPick', async (e, targetFolder: string, kind: 'files' | 'folder') => {
    const s = await requireSettings();
    const folder = safe(s, targetFolder);
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: kind === 'folder' ? 'Add a folder to the working copy' : 'Add files to the working copy',
      buttonLabel: 'Add',
      properties:
        kind === 'folder'
          ? ['openDirectory', 'dontAddToRecent']
          : ['openFile', 'multiSelections', 'dontAddToRecent'],
    });
    if (r.canceled || r.filePaths.length === 0) return { added: [] as string[] };
    return { added: await svnService.importPaths(s, folder, r.filePaths, (rel) => safe(s, rel)) };
  });

  // Drag-and-drop: the preload resolves dropped File objects to real paths.
  withWc('svn:importPaths', async (s, targetFolder: string, sources: string[]) => {
    const list = (Array.isArray(sources) ? sources : []).map(String).filter(Boolean);
    return { added: await svnService.importPaths(s, safe(s, targetFolder), list, (rel) => safe(s, rel)) };
  });

  // ---- AI review context -------------------------------------------------------------

  withWc('svn:aiContext', async (s, scope: AiScope, budget: number) => {
    const clean: AiScope = {
      files: safeList(s, scope?.files),
      folders: safeList(s, scope?.folders),
      changes: safeList(s, scope?.changes),
    };
    if (clean.files.length + clean.folders.length + clean.changes.length === 0) {
      throw new Error('Nothing in scope. Open a file, or use + to add a folder or your changes.');
    }
    const cap = Math.max(2_000, Math.min(60_000, Math.floor(Number(budget) || 12_000)));
    const result = await buildAiContext(s, clean, cap);
    if (!result.context.trim()) {
      throw new Error(
        'No readable text in the selected scope (binary files, empty folders and files over 200 KB are skipped).',
      );
    }
    return result;
  });
}
