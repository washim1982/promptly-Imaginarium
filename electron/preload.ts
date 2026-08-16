// Preload — the only surface the renderer gets onto the main process.
// Deliberately narrow: model file management, app info, and opening external
// links. No filesystem access, no arbitrary IPC.

import { contextBridge, ipcRenderer } from 'electron';

export interface LinkedModel {
  path: string;
  name: string;
  size: number;
  managed: boolean;
  linkedAt: number;
}

export interface DownloadTick {
  modelId: string;
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

  /** URL the renderer fetches to stream the linked model file off disk. */
  modelStreamUrl: (modelId: string): string =>
    `app://imaginarium/model/${encodeURIComponent(modelId)}`,

  /** The registered file for this model, or null if none / it moved away. */
  linkedModel: (modelId: string): Promise<LinkedModel | null> =>
    ipcRenderer.invoke('model:linked', modelId),

  /** Native file picker. Validates the file and registers it. */
  browseModel: (modelId: string): Promise<LinkedModel | null> =>
    ipcRenderer.invoke('model:browse', modelId),

  /** Forget the model. Downloaded files are deleted; user files never are. */
  unlinkModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('model:unlink', modelId),

  revealModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('model:revealInFolder', modelId),

  downloadModel: (
    modelId: string,
    url: string,
    fileName: string,
  ): Promise<LinkedModel> =>
    ipcRenderer.invoke('model:download', modelId, url, fileName),

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
