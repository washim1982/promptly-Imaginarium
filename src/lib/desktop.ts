// Typed view of the preload bridge (electron/preload.ts). Everything the
// renderer can ask the main process to do goes through here.

import type { AddResult, ModelEntry } from './models';

export interface DownloadTick {
  received: number;
  total: number | null;
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  chrome: string;
  searchApi: string;
}

export interface DesktopBridge {
  isDesktop: true;
  info(): Promise<AppInfo>;
  openExternal(url: string): Promise<void>;
  modelStreamUrl(id: string): string;
  listModels(): Promise<ModelEntry[]>;
  getModel(id: string): Promise<ModelEntry | null>;
  addModels(): Promise<AddResult>;
  removeModel(id: string): Promise<void>;
  renameModel(id: string, label: string): Promise<ModelEntry | null>;
  revealModel(id: string): Promise<void>;
  downloadModel(url: string, fileName: string): Promise<ModelEntry>;
  cancelDownload(): Promise<void>;
  onDownloadProgress(fn: (tick: DownloadTick) => void): () => void;
  storageUsage(): Promise<{ managedBytes: number; directory: string }>;
}

declare global {
  interface Window {
    imaginarium?: DesktopBridge;
  }
}

/** Present only inside Electron; `vite dev` in a plain browser leaves it unset. */
export const desktop: DesktopBridge | undefined = window.imaginarium;

export function requireDesktop(): DesktopBridge {
  if (!desktop) {
    throw new Error(
      'This build must run inside the Imaginarium desktop app (the native ' +
        'bridge is missing). Start it with `npm run dev`.',
    );
  }
  return desktop;
}

/** Open an http(s) link in the OS browser rather than inside the app window. */
export function openExternal(url: string): void {
  void desktop?.openExternal(url).catch(() => {});
}

// Electron wraps anything thrown in an ipcMain handler as
// "Error invoking remote method 'x': Error: <real message>". Strip that so the
// carefully-worded validation messages reach the user intact.
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

export function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(IPC_PREFIX, '').trim();
}

/** True when the failure was the user cancelling an in-flight download. */
export function isCancellation(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    cleanError(err) === 'DOWNLOAD_CANCELLED'
  );
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

/** Shorten a long path for display: C:\…\models\gemma-4-E2B-it-web.litertlm */
export function shortenPath(p: string, keep = 2): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep + 1) return p;
  return [parts[0], '…', ...parts.slice(-keep)].join('\\');
}
