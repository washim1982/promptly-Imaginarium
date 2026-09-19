// Renderer copies of the shapes in electron/svn/types.ts (the two sides are
// separate TypeScript projects, so they can't share a module).

export type SvnItemStatus =
  | 'normal'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'unversioned'
  | 'missing'
  | 'replaced'
  | 'conflicted'
  | 'ignored'
  | 'external'
  | 'incomplete'
  | 'merged'
  | 'obstructed';

export interface SvnTreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
  status: SvnItemStatus;
  locked: boolean;
  revision?: string;
  children?: SvnTreeNode[];
}

export interface SvnLogEntry {
  revision: string;
  author: string;
  date: string;
  message: string;
  paths: { path: string; action: string }[];
}

export interface SvnSettingsPublic {
  repoUrl: string;
  username: string;
  workingCopyPath: string;
  svnPath: string;
  hasPassword: boolean;
}

/** What the AI reviewer looks at. "" in folders means the whole working copy. */
export interface AiScope {
  files: string[];
  folders: string[];
  changes: string[];
}

export interface AiContext {
  context: string;
  truncated: boolean;
  fileCount: number;
}
