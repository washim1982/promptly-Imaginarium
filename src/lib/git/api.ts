// Git Pilot's window.gitPilot API, re-pointed at window.imaginarium.git. The
// method names and shapes match the original so the ported UI reads the same.

import { cleanError, requireDesktop } from '../desktop';
import type { AuthInfo, OperationResult, RecentRepo, RepoIdentity, RepoState } from './types';

/** One credential the scan found. The value itself never leaves the main process. */
export interface Finding {
  id: string;
  rule: string;
  ruleLabel: string;
  where: 'worktree' | 'history' | 'staged';
  path: string;
  line: number;
  /** The value with its middle replaced by dots. */
  masked: string;
  commit?: string;
  blob?: string;
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  blobsScanned: number;
  skipped: { large: number; binary: number };
  truncated: boolean;
  secretCount: number;
}

/** A line the rules didn't match, for the local model to judge. */
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
  scanCandidates(repo: string): Promise<CandidateResult>;
  removeSecrets(repo: string, findingIds: string[]): Promise<{ summary: RemovalSummary; state: RepoState }>;
  forcePush(repo: string, remote: string, branch: string): Promise<{ message: string; state: RepoState }>;
}

function bridge(): GitBridge {
  return (requireDesktop() as unknown as { git: GitBridge }).git;
}

/**
 * Proxy every bridge call so it rejects with Electron's IPC prefix stripped
 * but Git Studio's [CODE] markers intact — the UI branches on those
 * (REMOTE_NOT_FOUND opens the recovery dialog) before hiding them.
 */
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

/** What the user sees: the message without its [CODE] marker. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return cleanError(message)
    .replace(/^Error:\s*/i, '')
    .replace(/^\[(?:REMOTE_NOT_FOUND|AUTH_REQUIRED|LARGE_FILE)\]\s*/i, '')
    .trim();
}
