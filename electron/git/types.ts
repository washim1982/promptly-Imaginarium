
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
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: RepoFile[];
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
