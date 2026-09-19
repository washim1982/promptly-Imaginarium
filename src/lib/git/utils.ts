// Pure helpers for the Git Studio UI (from Git Pilot's App.tsx).

import type { FileChange, RepoState } from './types';

export function relativeDate(value: string): string {
  if (!value) return 'just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, divisor] of units) {
    if (Math.abs(seconds) >= divisor) return formatter.format(Math.round(seconds / divisor), unit);
  }
  return 'just now';
}

export function initials(name: string): string {
  return (
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'G'
  );
}

const STATUS_LABELS: Record<FileChange['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  untracked: 'New',
  conflicted: 'Conflict',
  unknown: 'Changed',
};

export const statusLabel = (change: FileChange) => STATUS_LABELS[change.status];

/** One-letter explorer badge, VS Code style. */
export function statusLetter(status: FileChange['status']): string {
  const letters: Record<FileChange['status'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    untracked: 'U',
    conflicted: '!',
    unknown: 'M',
  };
  return letters[status];
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  uploaded: boolean;
  status?: RepoState['files'][number]['status'];
  children: FileTreeNode[];
}

export function buildFileTree(files: RepoState['files']): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  // Folder lookup by path — Git Pilot searched each level's array linearly,
  // which is quadratic on wide folders.
  const folders = new Map<string, FileTreeNode>();

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let children = roots;
    let currentPath = '';

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (index === parts.length - 1) {
        children.push({ name: part, path: file.path, kind: 'file', uploaded: file.uploaded, status: file.status, children: [] });
        return;
      }
      let folder = folders.get(currentPath);
      if (!folder) {
        folder = { name: part, path: currentPath, kind: 'folder', uploaded: false, children: [] };
        folders.set(currentPath, folder);
        children.push(folder);
      }
      children = folder.children;
    });
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.forEach((node) => sortNodes(node.children));
    return nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });
  };

  return sortNodes(roots);
}

/** Sync hint under REMOTE SYNC. */
export function syncHint(repo: RepoState): string {
  if (!repo.remotes.length) return 'no remote connected';
  if (!repo.upstream) return 'not published yet';
  return repo.ahead || repo.behind ? 'sync available' : 'up to date';
}
