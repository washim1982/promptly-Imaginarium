// Read-only Google Drive access (drive.readonly): browse/search files and read
// one as text. Google Docs/Sheets/Slides are exported to text; PDFs come back
// as bytes so the renderer's pdf.js (already used by PDF Tools) extracts them.

import { googleGet, requireScope } from './auth';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

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

const FIELDS = 'id,name,mimeType,modifiedTime,size,owners(displayName),webViewLink';

interface RawFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  owners?: { displayName?: string }[];
  webViewLink?: string;
}

const toFile = (f: RawFile): DriveFile => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  modifiedTime: f.modifiedTime ?? '',
  size: f.size ? Number(f.size) : null,
  owner: f.owners?.[0]?.displayName ?? '',
  webViewLink: f.webViewLink ?? '',
  isFolder: f.mimeType === FOLDER,
});

/** Drive query string literal: backslash and quote escaped. */
export const driveLiteral = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const validId = (id: unknown) => {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Invalid Drive file id.');
  return id;
};

export function buildQuery(search: string, folderId?: string): string {
  const clauses = ['trashed = false'];
  if (folderId) clauses.push(`${driveLiteral(validId(folderId))} in parents`);
  const s = search.trim();
  if (s) clauses.push(`(name contains ${driveLiteral(s)} or fullText contains ${driveLiteral(s)})`);
  return clauses.join(' and ');
}

export async function listFiles(
  search: string,
  folderId?: string,
  pageToken?: string,
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  await requireScope('drive');
  const url = new URL(`${API}/files`);
  url.searchParams.set('q', buildQuery(search, folderId));
  url.searchParams.set('pageSize', '30');
  url.searchParams.set('fields', `nextPageToken,files(${FIELDS})`);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  // Drive refuses orderBy together with a fullText search.
  if (!search.trim()) url.searchParams.set('orderBy', 'folder,modifiedTime desc');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const res = (await googleGet(url.toString())) as { files?: RawFile[]; nextPageToken?: string };
  return { files: (res.files ?? []).map(toFile), nextPageToken: res.nextPageToken };
}

const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const isTextual = (mime: string) =>
  mime.startsWith('text/') ||
  /^application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|csv|x-python|typescript|x-typescript|rtf)$/.test(mime) ||
  mime.endsWith('+xml') ||
  mime.endsWith('+json');

export async function getFileContent(id: string): Promise<DriveContent> {
  await requireScope('drive');
  const fileId = validId(id);
  const meta = toFile(
    (await googleGet(`${API}/files/${fileId}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`)) as RawFile,
  );
  const base = { name: meta.name, mimeType: meta.mimeType, webViewLink: meta.webViewLink };

  const exportAs = EXPORTS[meta.mimeType];
  if (exportAs) {
    const text = (await googleGet(
      `${API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportAs)}`,
      'text',
      10 * 1024 * 1024,
    )) as string;
    return { kind: 'text', ...base, text };
  }
  if (meta.isFolder) throw new Error('That is a folder — open it to see its files.');
  if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new Error('This kind of Google file (form, drawing, site…) can’t be read as text.');
  }
  if (meta.mimeType === 'application/pdf') {
    const bytes = (await googleGet(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, 'bytes', MAX_PDF_BYTES)) as Buffer;
    return { kind: 'pdf', ...base, bytes: new Uint8Array(bytes) };
  }
  if (isTextual(meta.mimeType)) {
    const text = (await googleGet(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, 'text', MAX_TEXT_BYTES)) as string;
    return { kind: 'text', ...base, text };
  }
  throw new Error(`Can’t read ${meta.mimeType || 'this file type'} as text. Docs, Sheets, Slides, PDFs and text files are supported.`);
}
