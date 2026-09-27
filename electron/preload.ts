
import { contextBridge, ipcRenderer, webUtils } from 'electron';

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
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  aiContext: (scope: unknown, budget: number) => ipcRenderer.invoke('svn:aiContext', scope, budget),
};

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

  scanSecrets: (repo: string) => ipcRenderer.invoke('git:scanSecrets', repo),
  scanStaged: (repo: string) => ipcRenderer.invoke('git:scanStaged', repo),

  scanComments: (repo: string) => ipcRenderer.invoke('git:scanComments', repo),
  removeComments: (repo: string, ids: string[]) => ipcRenderer.invoke('git:removeComments', repo, ids),
  scanCandidates: (repo: string, scanId?: string) => ipcRenderer.invoke('git:scanCandidates', repo, scanId),
  removeSecrets: (repo: string, findingIds: string[], scanId?: string) => ipcRenderer.invoke('git:removeSecrets', repo, findingIds, scanId),
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

const agent = {
  getWorkspace: () => ipcRenderer.invoke('agent:getWorkspace'),
  pickWorkspace: () => ipcRenderer.invoke('agent:pickWorkspace'),
  clearWorkspace: () => ipcRenderer.invoke('agent:clearWorkspace'),
  listDir: (rel: string) => ipcRenderer.invoke('agent:listDir', rel),
  readFile: (rel: string, start?: number, end?: number) => ipcRenderer.invoke('agent:readFile', rel, start, end),
  searchFiles: (pattern: string, glob?: string) => ipcRenderer.invoke('agent:searchFiles', pattern, glob),
  writeFile: (rel: string, content: string) => ipcRenderer.invoke('agent:writeFile', rel, content),
  appendFile: (rel: string, content: string) => ipcRenderer.invoke('agent:appendFile', rel, content),
  runCommand: (command: string) => ipcRenderer.invoke('agent:runCommand', command),
  fetchUrl: (url: string) => ipcRenderer.invoke('agent:fetchUrl', url),
  listEntries: (rel: string) => ipcRenderer.invoke('agent:listEntries', rel),
  readForAttach: (rel: string) => ipcRenderer.invoke('agent:readForAttach', rel),
};

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

const auth0 = {
  status: () => ipcRenderer.invoke('auth0:status'),
  verify: () => ipcRenderer.invoke('auth0:verify'),
  saveClient: (input: { domain: string; clientId: string }) => ipcRenderer.invoke('auth0:saveClient', input),
  clearClient: () => ipcRenderer.invoke('auth0:clearClient'),
  login: () => ipcRenderer.invoke('auth0:login'),
  cancelLogin: () => ipcRenderer.invoke('auth0:cancelLogin'),
  logout: () => ipcRenderer.invoke('auth0:logout'),
};

const search = {
  status: () => ipcRenderer.invoke('search:status'),
  saveKey: (key: string, provider?: 'keenable' | 'tavily') => ipcRenderer.invoke('search:saveKey', key, provider),
  clearKey: (provider?: 'keenable' | 'tavily') => ipcRenderer.invoke('search:clearKey', provider),
  verifyKey: (key: string, provider?: 'keenable' | 'tavily') => ipcRenderer.invoke('search:verifyKey', key, provider),
  query: (query: string, maxResults?: number) => ipcRenderer.invoke('search:query', query, maxResults),
};

const bridge = {
  isDesktop: true as const,

  info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('app:openExternal', url),

  modelStreamUrl: (id: string): string =>
    `app://imaginarium/model/${encodeURIComponent(id)}`,

  listModels: (): Promise<ModelEntry[]> => ipcRenderer.invoke('model:list'),

  getModel: (id: string): Promise<ModelEntry | null> =>
    ipcRenderer.invoke('model:get', id),

  addModels: (): Promise<AddResult> => ipcRenderer.invoke('model:add'),

  removeModel: (id: string): Promise<void> =>
    ipcRenderer.invoke('model:remove', id),

  renameModel: (id: string, label: string): Promise<ModelEntry | null> =>
    ipcRenderer.invoke('model:rename', id, label),

  revealModel: (id: string): Promise<void> =>
    ipcRenderer.invoke('model:revealInFolder', id),

  downloadModel: (url: string, fileName: string): Promise<ModelEntry> =>
    ipcRenderer.invoke('model:download', url, fileName),

  cancelDownload: (): Promise<void> => ipcRenderer.invoke('model:cancelDownload'),

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
  search,
};

export type DesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld('imaginarium', bridge);
