// Pure helpers from SVN Studio's web/client/src/utils/*, merged into one module.

import type { SvnItemStatus, SvnTreeNode } from './types';

// ---- tree ------------------------------------------------------------------------

export interface FlatEntry {
  path: string;
  name: string;
  isDirectory: boolean;
}

export function flattenTree(node: SvnTreeNode | null, out: FlatEntry[] = []): FlatEntry[] {
  if (!node) return out;
  if (node.path) out.push({ path: node.path, name: node.name, isDirectory: node.isDirectory });
  node.children?.forEach((child) => flattenTree(child, out));
  return out;
}

/** Folders first, then alphabetical — the order every tree view uses. */
export function sortNodes(nodes: SvnTreeNode[]): SvnTreeNode[] {
  return nodes
    .slice()
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

/**
 * Keep a node only if it changed itself or is an ancestor of something that
 * did — so the commit panel shows real folder structure for context without
 * listing every untouched file in the working copy.
 */
export function pruneToChanges(node: SvnTreeNode): SvnTreeNode | null {
  const children = (node.children ?? [])
    .map(pruneToChanges)
    .filter((c): c is SvnTreeNode => c !== null);
  if (node.status !== 'normal' || children.length > 0) return { ...node, children };
  return null;
}

/**
 * Paths in this subtree that changed themselves — valid commit/revert targets.
 * Includes the working-copy root ("") when it has a property change of its own.
 */
export function collectChangedPaths(node: SvnTreeNode, out: string[] = []): string[] {
  if (node.status !== 'normal') out.push(node.path);
  node.children?.forEach((child) => collectChangedPaths(child, out));
  return out;
}

/**
 * Changes to pre-select for commit: everything svn already tracks. Unversioned
 * items are left unticked, as in TortoiseSVN — committing adds them, so
 * pre-selecting would quietly commit build output and stray files.
 */
export function defaultCommitSelection(node: SvnTreeNode, out: string[] = []): string[] {
  if (node.status !== 'normal' && node.status !== 'unversioned') out.push(node.path);
  node.children?.forEach((child) => defaultCommitSelection(child, out));
  return out;
}

export function countStatuses(node: SvnTreeNode | null): { changed: number; conflicted: number } {
  let changed = 0;
  let conflicted = 0;
  (function walk(n: SvnTreeNode | null) {
    if (!n) return;
    if (n.status !== 'normal') changed++;
    if (n.status === 'conflicted') conflicted++;
    n.children?.forEach(walk);
  })(node);
  return { changed, conflicted };
}

// ---- status styling ------------------------------------------------------------------

export const STATUS_ICON: Record<string, string> = {
  modified: '●',
  added: '+',
  deleted: '−',
  conflicted: '⚠',
  unversioned: '?',
  missing: '!',
  replaced: '↻',
  normal: '',
};

export function statusBadgeClass(status: string): string {
  return ['modified', 'added', 'deleted', 'conflicted', 'unversioned', 'missing', 'replaced'].includes(status)
    ? `svn-badge svn-badge--${status}`
    : '';
}

export function nameClass(status: SvnItemStatus | string): string {
  switch (status) {
    case 'added':
    case 'unversioned':
      return 'svn-tree__name--added';
    case 'modified':
    case 'replaced':
      return 'svn-tree__name--modified';
    case 'deleted':
    case 'missing':
      return 'svn-tree__name--deleted';
    case 'conflicted':
      return 'svn-tree__name--conflicted';
    default:
      return '';
  }
}

// ---- languages ----------------------------------------------------------------------

const LANGUAGES: Record<string, [display: string, monaco: string]> = {
  ts: ['TypeScript', 'typescript'],
  tsx: ['TypeScript React', 'typescript'],
  js: ['JavaScript', 'javascript'],
  jsx: ['JavaScript React', 'javascript'],
  mjs: ['JavaScript', 'javascript'],
  cjs: ['JavaScript', 'javascript'],
  json: ['JSON', 'json'],
  css: ['CSS', 'css'],
  scss: ['SCSS', 'scss'],
  html: ['HTML', 'html'],
  md: ['Markdown', 'markdown'],
  py: ['Python', 'python'],
  java: ['Java', 'java'],
  cs: ['C#', 'csharp'],
  cpp: ['C++', 'cpp'],
  c: ['C', 'c'],
  h: ['C/C++ Header', 'cpp'],
  go: ['Go', 'go'],
  rs: ['Rust', 'rust'],
  xml: ['XML', 'xml'],
  xaml: ['XAML', 'xml'],
  yml: ['YAML', 'yaml'],
  yaml: ['YAML', 'yaml'],
  sql: ['SQL', 'sql'],
  sh: ['Shell', 'shell'],
  ps1: ['PowerShell', 'powershell'],
  bat: ['Batch', 'bat'],
};

const extOf = (path: string | null) => (path ? (path.split('.').pop() ?? '').toLowerCase() : '');

export function monacoLanguageFromPath(path: string | null): string {
  return LANGUAGES[extOf(path)]?.[1] ?? 'plaintext';
}

export function displayLanguageFromPath(path: string | null): string {
  if (!path) return 'Plain Text';
  return LANGUAGES[extOf(path)]?.[0] ?? 'Plain Text';
}

export const baseName = (p: string) => p.split('/').pop() || p;
export const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
