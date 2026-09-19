// Preload — the only surface the renderer gets onto the main process.
// Deliberately narrow: model library management, app info, and opening external
// links. No filesystem access, no arbitrary IPC.

import { contextBridge, ipcRenderer, webUtils } from 'electron';

// SVN Studio tab. Thin passthroughs — shapes and validation live in
// electron/svn/ipc.ts, typed for the renderer in src/lib/svn/api.ts.
const svn = {
  getSettings: () => ipcRenderer.invoke('svn:getSettings'),
  saveSettings: (input: unknown) => ipcRenderer.invoke('svn:saveSettings', input),
  detect: (svnPath?: string) => ipcRenderer.invoke('svn:detect', svnPath),
  checkout: () => ipcRenderer.invoke('svn:checkout'),
  relink: (workingCopyPath: string) => ipcRenderer.invoke('svn:relink', workingCopyPath),
  browseFolder: (title?: string) => ipcRenderer.invoke('svn:browseFolder', title),
  browseSvnExe: () => ipcRenderer.invoke('svn:browseSvnExe'),

  tree: () => ipcRenderer.invoke('svn:tree'),
  status: () => ipcRenderer.invoke('svn:status'),
  file: (path: string) => ipcRenderer.invoke('svn:file', path),
  diff: (path: string) => ipcRenderer.invoke('svn:diff', path),
  history: (path?: string) => ipcRenderer.invoke('svn:history', path),

  saveFile: (path: string, content: string) => ipcRenderer.invoke('svn:saveFile', path, content),
  createFile: (path: string) => ipcRenderer.invoke('svn:createFile', path),
  createFolder: (path: string) => ipcRenderer.invoke('svn:createFolder', path),
  delete: (path: string) => ipcRenderer.invoke('svn:delete', path),
  rename: (from: string, to: string) => ipcRenderer.invoke('svn:rename', from, to),
  commit: (paths: string[], message: string) => ipcRenderer.invoke('svn:commit', paths, message),
  update: () => ipcRenderer.invoke('svn:update'),
  revert: (paths: string[]) => ipcRenderer.invoke('svn:revert', paths),
  lock: (path: string, message?: string) => ipcRenderer.invoke('svn:lock', path, message),
  unlock: (path: string) => ipcRenderer.invoke('svn:unlock', path),

  uploadPick: (targetFolder: string, kind: 'files' | 'folder') =>
    ipcRenderer.invoke('svn:uploadPick', targetFolder, kind),
  importPaths: (targetFolder: string, sources: string[]) =>
    ipcRenderer.invoke('svn:importPaths', targetFolder, sources),
  /** Real on-disk path of a dropped File (File.path no longer exists). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  aiContext: (scope: unknown, budget: number) => ipcRenderer.invoke('svn:aiContext', scope, budget),
};

// Git Studio tab (Git Pilot port). Handlers live in electron/git/ipc.ts,
// typed for the renderer in src/lib/git/api.ts.
const git = {
  gitVersion: () => ipcRenderer.invoke('git:gitVersion'),
  openRepository: () => ipcRenderer.invoke('git:openRepository'),
  chooseFolder: () => ipcRenderer.invoke('git:chooseFolder'),
  getRecentRepositories: () => ipcRenderer.invoke('git:recent'),
  forgetRepository: (repoPath: string) => ipcRenderer.invoke('git:forget', repoPath),
  loadRepository: (repoPath: string) => ipcRenderer.invoke('git:load', repoPath),
  cloneRepository: (input: { url: string; parent: string; name?: string }) => ipcRenderer.invoke('git:clone', input),
  initRepository: (folder: string) => ipcRenderer.invoke('git:init', folder),
  stage: (repo: string, files: string[]) => ipcRenderer.invoke('git:stage', repo, files),
  unstage: (repo: string, files: string[]) => ipcRenderer.invoke('git:unstage', repo, files),
  discard: (repo: string, files: string[]) => ipcRenderer.invoke('git:discard', repo, files),
  commit: (repo: string, message: string) => ipcRenderer.invoke('git:commit', repo, message),
  fetch: (repo: string) => ipcRenderer.invoke('git:fetch', repo),
  pull: (repo: string) => ipcRenderer.invoke('git:pull', repo),
  push: (repo: string) => ipcRenderer.invoke('git:push', repo),
  switchBranch: (repo: string, branch: string) => ipcRenderer.invoke('git:switchBranch', repo, branch),
  createBranch: (repo: string, branch: string) => ipcRenderer.invoke('git:createBranch', repo, branch),
  mergeBranch: (repo: string, source: string) => ipcRenderer.invoke('git:mergeBranch', repo, source),
  addRemote: (repo: string, name: string, url: string) => ipcRenderer.invoke('git:addRemote', repo, name, url),
  saveIdentity: (repo: string, identity: { name: string; email: string }, global: boolean) =>
    ipcRenderer.invoke('git:saveIdentity', repo, identity, global),
  authInfo: () => ipcRenderer.invoke('git:authInfo'),
  signIn: (repo: string) => ipcRenderer.invoke('git:signIn', repo),
  openInExplorer: (repo: string) => ipcRenderer.invoke('git:openExplorer', repo),
  openTerminal: (repo: string) => ipcRenderer.invoke('git:openTerminal', repo),
  openCreateRemote: (repo: string) => ipcRenderer.invoke('git:openCreateRemote', repo),

  // Credential scan: find secrets in the working tree and the history, remove
  // the selected ones (rewriting history), then optionally force-push.
  scanSecrets: (repo: string) => ipcRenderer.invoke('git:scanSecrets', repo),
  scanCandidates: (repo: string) => ipcRenderer.invoke('git:scanCandidates', repo),
  removeSecrets: (repo: string, findingIds: string[]) => ipcRenderer.invoke('git:removeSecrets', repo, findingIds),
  forcePush: (repo: string, remote: string, branch: string) => ipcRenderer.invoke('git:forcePush', repo, remote, branch),
};

export interface ModelEntry {
  id: string;
  label: string;
  path: string;
  name: string;
  size: number;
  managed: boolean;
  addedAt: number;
  lastUsedAt: number | null;
}

export interface AddResult {
  added: ModelEntry[];
  rejected: { name: string; reason: string }[];
}

export interface DownloadTick {
  received: number;
  total: number | null;
}

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  electron: string;
  chrome: string;
  searchApi: string;
}

// Chat agent tools. The workspace root is held by main; calls take only
// workspace-relative paths.
const agent = {
  getWorkspace: () => ipcRenderer.invoke('agent:getWorkspace'),
  pickWorkspace: () => ipcRenderer.invoke('agent:pickWorkspace'),
  clearWorkspace: () => ipcRenderer.invoke('agent:clearWorkspace'),
  listDir: (rel: string) => ipcRenderer.invoke('agent:listDir', rel),
  readFile: (rel: string, start?: number, end?: number) => ipcRenderer.invoke('agent:readFile', rel, start, end),
  searchFiles: (pattern: string, glob?: string) => ipcRenderer.invoke('agent:searchFiles', pattern, glob),
  writeFile: (rel: string, content: string) => ipcRenderer.invoke('agent:writeFile', rel, content),
  runCommand: (command: string) => ipcRenderer.invoke('agent:runCommand', command),
  fetchUrl: (url: string) => ipcRenderer.invoke('agent:fetchUrl', url),
  listEntries: (rel: string) => ipcRenderer.invoke('agent:listEntries', rel),
  readForAttach: (rel: string) => ipcRenderer.invoke('agent:readForAttach', rel),
};

// Chat sidebar: Google account (read-only Gmail + Drive). Tokens stay in main;
// see electron/google/.
const google = {
  status: () => ipcRenderer.invoke('google:status'),
  saveClient: (input: { clientId: string; clientSecret: string }) => ipcRenderer.invoke('google:saveClient', input),
  clearClient: () => ipcRenderer.invoke('google:clearClient'),
  connect: () => ipcRenderer.invoke('google:connect'),
  cancelConnect: () => ipcRenderer.invoke('google:cancelConnect'),
  disconnect: () => ipcRenderer.invoke('google:disconnect'),
  listMail: (query: string, pageToken?: string) => ipcRenderer.invoke('gmail:list', query, pageToken),
  getMail: (id: string) => ipcRenderer.invoke('gmail:get', id),
  listDrive: (search: string, folderId?: string, pageToken?: string) =>
    ipcRenderer.invoke('drive:list', search, folderId, pageToken),
  getDriveFile: (id: string) => ipcRenderer.invoke('drive:get', id),
};

// Optional app login (Auth0) — required before connecting Google. Tokens stay
// in main; see electron/auth0/.
const auth0 = {
  status: () => ipcRenderer.invoke('auth0:status'),
  verify: () => ipcRenderer.invoke('auth0:verify'),
  saveClient: (input: { domain: string; clientId: string }) => ipcRenderer.invoke('auth0:saveClient', input),
  clearClient: () => ipcRenderer.invoke('auth0:clearClient'),
  login: () => ipcRenderer.invoke('auth0:login'),
  cancelLogin: () => ipcRenderer.invoke('auth0:cancelLogin'),
  logout: () => ipcRenderer.invoke('auth0:logout'),
};

const bridge = {
  isDesktop: true as const,

  info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('app:openExternal', url),

  /** URL the renderer fetches to stream a library model off disk. */
  modelStreamUrl: (id: string): string =>
    `app://imaginarium/model/${encodeURIComponent(id)}`,

  /** Every model in the library, with entries whose files vanished pruned. */
  listModels: (): Promise<ModelEntry[]> => ipcRenderer.invoke('model:list'),

  getModel: (id: string): Promise<ModelEntry | null> =>
    ipcRenderer.invoke('model:get', id),

  /** Native multi-select picker. Each file is validated independently. */
  addModels: (): Promise<AddResult> => ipcRenderer.invoke('model:add'),

  /** Remove from the library. Downloaded files are deleted; user files are not. */
  removeModel: (id: string): Promise<void> =>
    ipcRenderer.invoke('model:remove', id),

  renameModel: (id: string, label: string): Promise<ModelEntry | null> =>
    ipcRenderer.invoke('model:rename', id, label),

  revealModel: (id: string): Promise<void> =>
    ipcRenderer.invoke('model:revealInFolder', id),

  /** Download a suggested model; it joins the library like any other file. */
  downloadModel: (url: string, fileName: string): Promise<ModelEntry> =>
    ipcRenderer.invoke('model:download', url, fileName),

  cancelDownload: (): Promise<void> => ipcRenderer.invoke('model:cancelDownload'),

  /** Subscribe to download progress. Returns an unsubscribe function. */
  onDownloadProgress: (fn: (tick: DownloadTick) => void): (() => void) => {
    const listener = (_e: unknown, tick: DownloadTick) => fn(tick);
    ipcRenderer.on('model:downloadProgress', listener);
    return () => ipcRenderer.off('model:downloadProgress', listener);
  },

  storageUsage: (): Promise<{ managedBytes: number; directory: string }> =>
    ipcRenderer.invoke('storage:usage'),

  svn,
  git,
  agent,
  google,
  auth0,
};

export type DesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld('imaginarium', bridge);
