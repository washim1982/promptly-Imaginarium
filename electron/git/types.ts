// Shapes shared by the Git Studio main-process service and the renderer
// (re-exported for the UI from src/lib/git/types.ts). Ported from Git Pilot's
// src/types.ts.

export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'unknown';

export interface FileChange {
  path: string;
  oldPath?: string;
  indexCode: string;
  workTreeCode: string;
  staged: boolean;
  unstaged: boolean;
  status: ChangeStatus;
}

export interface RepoFile {
  path: string;
  tracked: boolean;
  /** Present in the upstream branch's tree — i.e. already pushed. */
  uploaded: boolean;
  status?: ChangeStatus;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  upstream: string;
  lastCommitDate: string;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface RepoIdentity {
  name: string;
  email: string;
}

export interface RepoState {
  root: string;
  name: string;
  /** Branch name, or DETACHED_HEAD. An unborn branch (no commits yet) still has its name. */
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: RepoFile[];
  /** True when the repository had more files than the explorer lists. */
  filesTruncated: boolean;
  changes: FileChange[];
  commits: CommitInfo[];
  branches: BranchInfo[];
  remotes: RemoteInfo[];
  identity: RepoIdentity;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpened: string;
}

export interface AuthInfo {
  credentialManagerInstalled: boolean;
  credentialManagerVersion: string;
  helper: string;
}

export interface OperationResult {
  message: string;
  state?: RepoState;
}

export const DETACHED_HEAD = 'Detached HEAD';
