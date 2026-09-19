// SVN Studio's client API (web/client/src/api/svnApi.ts), re-pointed from
// fetch('/api/...') at the Electron main process over IPC. The method names and
// shapes match the original so the ported components need no changes to call it.

import { cleanError, requireDesktop } from '../desktop';
import type { AiContext, AiScope, SvnLogEntry, SvnSettingsPublic, SvnTreeNode } from './types';

interface SvnBridge {
  getSettings(): Promise<SvnSettingsPublic>;
  saveSettings(input: SaveSettingsInput): Promise<SvnSettingsPublic>;
  detect(svnPath?: string): Promise<{ exe: string; version: string }>;
  checkout(): Promise<{ output: string }>;
  relink(workingCopyPath: string): Promise<SvnSettingsPublic>;
  browseFolder(title?: string): Promise<string | null>;
  browseSvnExe(): Promise<string | null>;
  tree(): Promise<SvnTreeNode>;
  file(path: string): Promise<string>;
  diff(path: string): Promise<string>;
  history(path?: string): Promise<SvnLogEntry[]>;
  saveFile(path: string, content: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  commit(paths: string[], message: string): Promise<{ output: string }>;
  update(): Promise<{ output: string }>;
  revert(paths: string[]): Promise<{ output: string }>;
  lock(path: string, message?: string): Promise<void>;
  unlock(path: string): Promise<void>;
  uploadPick(targetFolder: string, kind: 'files' | 'folder'): Promise<{ added: string[] }>;
  importPaths(targetFolder: string, sources: string[]): Promise<{ added: string[] }>;
  pathForFile(file: File): string;
  aiContext(scope: AiScope, budget: number): Promise<AiContext>;
}

export interface SaveSettingsInput {
  repoUrl: string;
  username: string;
  password?: string;
  workingCopyPath: string;
  svnPath?: string;
}

function bridge(): SvnBridge {
  return (requireDesktop() as unknown as { svn: SvnBridge }).svn;
}

/** Call through to main, re-throwing with Electron's IPC prefix stripped. */
async function call<T>(fn: (b: SvnBridge) => Promise<T>): Promise<T> {
  try {
    return await fn(bridge());
  } catch (err) {
    throw new Error(cleanError(err));
  }
}

export const svnApi = {
  getTree: () => call((b) => b.tree()),
  getFile: (path: string) => call((b) => b.file(path)),
  getDiff: (path: string) => call((b) => b.diff(path)),
  saveFile: (path: string, content: string) => call((b) => b.saveFile(path, content)),
  getHistory: (path?: string) => call((b) => b.history(path)),

  createFile: (path: string) => call((b) => b.createFile(path)),
  createFolder: (path: string) => call((b) => b.createFolder(path)),
  deletePath: (path: string) => call((b) => b.delete(path)),
  renamePath: (from: string, to: string) => call((b) => b.rename(from, to)),
  commit: (paths: string[], message: string) => call((b) => b.commit(paths, message)),
  update: () => call((b) => b.update()),
  revert: (paths: string[]) => call((b) => b.revert(paths)),
  lock: (path: string, message?: string) => call((b) => b.lock(path, message)),
  unlock: (path: string) => call((b) => b.unlock(path)),

  /** Native picker for files or a whole folder, copied in and `svn add`ed. */
  uploadPick: (targetFolder: string, kind: 'files' | 'folder') =>
    call((b) => b.uploadPick(targetFolder, kind)),
  /** Files dropped from Explorer onto a tree folder. */
  importFiles: (targetFolder: string, files: FileList | File[]) =>
    call((b) => {
      const paths = Array.from(files).map((f) => b.pathForFile(f)).filter(Boolean);
      return b.importPaths(targetFolder, paths);
    }),

  getSettings: () => call((b) => b.getSettings()),
  saveSettings: (input: SaveSettingsInput) => call((b) => b.saveSettings(input)),
  detectSvn: (svnPath?: string) => call((b) => b.detect(svnPath)),
  checkoutRepository: () => call((b) => b.checkout()),
  relinkWorkingCopy: (workingCopyPath: string) => call((b) => b.relink(workingCopyPath)),
  browseFolder: (title?: string) => call((b) => b.browseFolder(title)),
  browseSvnExe: () => call((b) => b.browseSvnExe()),

  aiContext: (scope: AiScope, budget: number) => call((b) => b.aiContext(scope, budget)),
};
