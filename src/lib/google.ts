// Renderer side of the Google account integration (electron/google/). Typed
// passthroughs; tokens never reach this side.

import { cleanError, requireDesktop } from './desktop';

export interface GoogleStatus {
  configured: boolean;
  clientSource: 'env' | 'saved' | null;
  clientIdHint: string;
  connected: boolean;
  email: string;
  gmail: boolean;
  drive: boolean;
  canPersist: boolean;
}

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface MailMessage extends MailSummary {
  to: string;
  cc: string;
  body: string;
  attachments: string[];
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
  owner: string;
  webViewLink: string;
  isFolder: boolean;
}

export type DriveContent =
  | { kind: 'text'; name: string; mimeType: string; text: string; webViewLink: string }
  | { kind: 'pdf'; name: string; mimeType: string; bytes: Uint8Array; webViewLink: string };

interface GoogleBridge {
  status(): Promise<GoogleStatus>;
  saveClient(input: { clientId: string; clientSecret: string }): Promise<GoogleStatus>;
  clearClient(): Promise<GoogleStatus>;
  connect(): Promise<GoogleStatus>;
  cancelConnect(): Promise<void>;
  disconnect(): Promise<GoogleStatus>;
  listMail(query: string, pageToken?: string): Promise<{ messages: MailSummary[]; nextPageToken?: string }>;
  getMail(id: string): Promise<MailMessage>;
  listDrive(search: string, folderId?: string, pageToken?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  getDriveFile(id: string): Promise<DriveContent>;
}

const bridge = () => (requireDesktop() as unknown as { google: GoogleBridge }).google;

/** Every call rejects with Electron's IPC prefix stripped. */
export const googleApi: GoogleBridge = new Proxy({} as GoogleBridge, {
  get(_t, key: keyof GoogleBridge) {
    return async (...args: unknown[]) => {
      try {
        return await (bridge()[key] as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (err) {
        throw new Error(cleanError(err));
      }
    };
  },
});

/** "Ada Lovelace <ada@example.com>" → "Ada Lovelace". */
export function senderName(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  return (m?.[1] || from).trim() || from;
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

const DRIVE_KINDS: Record<string, string> = {
  'application/vnd.google-apps.folder': 'Folder',
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.spreadsheet': 'Sheet',
  'application/vnd.google-apps.presentation': 'Slides',
  'application/pdf': 'PDF',
};

export function driveKind(mime: string): string {
  if (DRIVE_KINDS[mime]) return DRIVE_KINDS[mime];
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('text/')) return 'Text';
  return mime.split('/').pop()?.replace(/^vnd\.[\w-]+\./, '').slice(0, 10) || 'File';
}
