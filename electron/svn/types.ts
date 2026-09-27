
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

export interface SvnStatusEntry {
  path: string;
  status: SvnItemStatus;
  locked: boolean;
  revision?: string;
  isDirectory: boolean;
}

export interface SvnLogEntry {
  revision: string;
  author: string;
  date: string;
  message: string;
  paths: { path: string; action: string }[];
}

export interface SvnSettings {
  repoUrl: string;
  username: string;
  password: string;
  workingCopyPath: string;
  svnPath: string;
}

export interface SvnSettingsPublic {
  repoUrl: string;
  username: string;
  workingCopyPath: string;
  svnPath: string;
  hasPassword: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

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
