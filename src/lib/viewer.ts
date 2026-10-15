// File Viewer: the bridge wrapper, and deciding how a file should be shown.

import { requireDesktop } from './desktop';

export interface FileRef {
  path: string;
  name: string;
  size: number;
}

export interface FileContents extends FileRef {
  text: string;
  truncated: boolean;
}

interface ViewerBridge {
  pick(): Promise<FileRef[]>;
  accept(paths: string[]): Promise<FileRef[]>;
  read(file: string): Promise<FileContents>;
  reveal(file: string): Promise<void>;
  pathForFile(file: File): string;
}

const bridge = () => (requireDesktop() as unknown as { viewer: ViewerBridge }).viewer;

export const viewerApi = {
  pick: () => bridge().pick(),
  accept: (paths: string[]) => bridge().accept(paths),
  read: (file: string) => bridge().read(file),
  reveal: (file: string) => bridge().reveal(file),
  pathForFile: (file: File) => bridge().pathForFile(file),
};

export type FileKind = 'markdown' | 'html' | 'code';

const MARKDOWN = new Set(['md', 'markdown', 'mdx', 'mdown']);
const HTML = new Set(['html', 'htm', 'xhtml']);

export const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** Markdown and HTML get a rendered view; everything readable is code. */
export function kindOf(name: string): FileKind {
  const ext = extensionOf(name);
  if (MARKDOWN.has(ext)) return 'markdown';
  if (HTML.has(ext)) return 'html';
  return 'code';
}

/**
 * HTML prepared for a sandboxed iframe.
 *
 * The iframe is already `sandbox=""`, so scripts cannot run and the frame has
 * an opaque origin — it cannot reach the app's own page or the preload bridge.
 * The injected policy closes the remaining hole: a local file should not be
 * able to call home, so remote images, stylesheets, fonts and frames are
 * blocked too. Inline styles still apply, which is what a saved report or an
 * exported document needs.
 */
export function sandboxHtml(html: string): string {
  const policy =
    '<meta http-equiv="Content-Security-Policy" content="' +
    "default-src 'none'; img-src data: blob:; media-src data: blob:; " +
    "style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'" +
    '">';
  // Put the policy first, inside <head> when there is one.
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + policy + html.slice(at);
  }
  return policy + html;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
