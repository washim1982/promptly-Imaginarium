
import { cleanError, requireDesktop } from '../desktop';
import type { AuthInfo, OperationResult, RecentRepo, RepoIdentity, RepoState } from './types';

export interface Finding {
  id: string;
  rule: string;
  ruleLabel: string;
  where: 'worktree' | 'history' | 'staged';
  path: string;
  line: number;
  masked: string;
  commit?: string;
  blob?: string;
}

export interface ScanResult {
  scanId?: string;
  findings: Finding[];
  filesScanned: number;
  blobsScanned: number;
  skipped: { large: number; binary: number };
  truncated: boolean;
  secretCount: number;
}

export interface Candidate {
  id: string;
  path: string;
  line: number;
  where: 'worktree' | 'history';
  commit?: string;
  snippet: string;
  value: string;
}

export interface CandidateResult {
  candidates: Candidate[];
  linesConsidered: number;
  truncated: boolean;
}

export interface RemovalSummary {
  backupPath: string;
  filesChanged: string[];
  blobsRewritten: number;
  commitsRewritten: number;
  refsUpdated: string[];
  tagsSkipped: string[];
  signaturesDropped: number;
  historyRewritten: boolean;
}

export type CommentKind = 'directive' | 'license' | 'sensitive' | 'dead-code' | 'task' | 'doc' | 'prose';

export interface CommentFinding {
  id: string;
  file: string;
  line: number;
  kind: CommentKind;
  locked: boolean;
  preview: string;
  lines: number;
  chars: number;
  detail?: string;
}

export interface CommentScanResult {
  findings: CommentFinding[];
  filesScanned: number;
  filesWithComments: number;
  totalComments: number;
  totalChars: number;
  sourceChars: number;
  skipped: { unsupported: number; large: number; unreadable: number; minified: number };
  truncated: boolean;
}

export interface CommentRemoval {
  filesChanged: string[];
  removed: number;
  stale: number;
  refused: number;
  linesRemoved: number;
}

interface GitBridge {
  gitVersion(): Promise<string>;
  openRepository(): Promise<RepoState | null>;
  chooseFolder(): Promise<string | null>;
  getRecentRepositories(): Promise<RecentRepo[]>;
  forgetRepository(repoPath: string): Promise<RecentRepo[]>;
  loadRepository(repoPath: string): Promise<RepoState>;
  cloneRepository(input: { url: string; parent: string; name?: string }): Promise<RepoState>;
  initRepository(folder: string): Promise<RepoState>;
  stage(repo: string, files: string[]): Promise<OperationResult>;
  unstage(repo: string, files: string[]): Promise<OperationResult>;
  discard(repo: string, files: string[]): Promise<OperationResult>;
  commit(repo: string, message: string): Promise<OperationResult>;
  fetch(repo: string): Promise<OperationResult>;
  pull(repo: string): Promise<OperationResult>;
  push(repo: string): Promise<OperationResult>;
  switchBranch(repo: string, branch: string): Promise<OperationResult>;
  createBranch(repo: string, branch: string): Promise<OperationResult>;
  mergeBranch(repo: string, sourceBranch: string): Promise<OperationResult>;
  addRemote(repo: string, name: string, url: string): Promise<OperationResult>;
  saveIdentity(repo: string, identity: RepoIdentity, global: boolean): Promise<OperationResult>;
  authInfo(): Promise<AuthInfo>;
  signIn(repo: string): Promise<OperationResult>;
  openInExplorer(repo: string): Promise<void>;
  openTerminal(repo: string): Promise<void>;
  openCreateRemote(repo: string): Promise<void>;
  scanSecrets(repo: string): Promise<ScanResult>;
  scanStaged(repo: string): Promise<ScanResult>;
  scanComments(repo: string): Promise<CommentScanResult>;
  removeComments(repo: string, ids: string[]): Promise<{ result: CommentRemoval; state: RepoState }>;
  scanCandidates(repo: string, scanId?: string): Promise<CandidateResult>;
  removeSecrets(repo: string, findingIds: string[], scanId?: string): Promise<{ summary: RemovalSummary; state: RepoState | null; warning?: string }>;
  forcePush(repo: string, remote: string, branch: string): Promise<{ message: string; state: RepoState }>;
}

function bridge(): GitBridge {
  return (requireDesktop() as unknown as { git: GitBridge }).git;
}

export const gitApi: GitBridge = new Proxy({} as GitBridge, {
  get(_target, key: keyof GitBridge) {
    return async (...args: unknown[]) => {
      try {
        return await (bridge()[key] as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (err) {
        throw new Error(cleanError(err));
      }
    };
  },
});

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return cleanError(message)
    .replace(/^Error:\s*/i, '')
    .replace(/^\[(?:REMOTE_NOT_FOUND|AUTH_REQUIRED|LARGE_FILE)\]\s*/i, '')
    .trim();
}
