// Shared shapes for the SVN Studio port. Ported from SVN Studio's
// web/server/src/types/svn.types.ts, minus the OpenAI-endpoint AI settings — AI
// review runs on the in-app LiteRT-LM model instead of an HTTP server.

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
  path: string; // relative to the working copy root, "/"-separated
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
  password: string; // encrypted at rest with safeStorage, decrypted only in-process
  workingCopyPath: string;
  /** Explicit svn.exe; blank = auto-detect (PATH, then known install folders). */
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
