// Preload — the only surface the renderer gets onto the main process.
// Deliberately narrow: model library management, app info, and opening external
// links. No filesystem access, no arbitrary IPC.

import { contextBridge, ipcRenderer } from 'electron';

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
};

export type DesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld('imaginarium', bridge);
