// Git operations for the Git Studio tab. Port of Git Pilot's
// electron/git-service.ts, with these changes:
//
//  - git runs via spawn with a timeout that kills the whole process tree
//    (git → git-remote-https → credential helper), not just git.exe.
//  - Every user-supplied value that lands on a git command line is kept from
//    being read as an option: clone URLs go after `--`, and branch/remote names
//    and URLs that start with "-" are rejected. (`git clone --upload-pack=…`
//    runs a program.)
//  - File operations use --literal-pathspecs, so a file named `*.js` or
//    `:(top)` means that file rather than a pattern, and they are batched so a
//    large selection doesn't overflow the Windows command-line limit.
//  - Status lists untracked files individually (-uall). Git Pilot's default
//    collapsed an untracked folder to "dir/", which Discard's `git clean -f`
//    then silently skipped (it needs -d for directories).
//  - A fresh repository with no commits shows its branch name instead of
//    "Detached HEAD", so the first push isn't refused.
//  - Branch listing uses a control-character separator, since `|` is legal in
//    a branch name.
//  - Repository state loads in one parallel round of git calls instead of
//    several dependent ones (see readState).

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  DETACHED_HEAD,
  type ChangeStatus,
  type FileChange,
  type OperationResult,
  type RepoState,
} from './types';

interface CommandOptions {
  timeout?: number;
  allowFailure?: boolean;
}

const MAX_OUTPUT = 64 * 1024 * 1024;
/** The explorer lists at most this many files; state is re-sent on every operation. */
const MAX_FILES = 20_000;
/** Total path characters per batched git call — well inside Windows' 32K limit. */
const BATCH_CHARS = 20_000;
const LARGE_FILE_BYTES = 100 * 1024 * 1024;

export function friendlyGitError(detail: string): string {
  const cleaned = detail.replace(/^(?:error|fatal):\s*/i, '').trim();
  if (/SEC_E_NO_CREDENTIALS|no credentials are available|authentication failed|could not read Username|terminal prompts disabled/i.test(cleaned)) {
    return '[AUTH_REQUIRED] Sign-in is required before this repository can be reached.';
  }
  if (/repository(?:\s+['"].*?['"])?\s+not found/i.test(cleaned)) {
    return '[REMOTE_NOT_FOUND] GitHub could not find this repository, or the signed-in account does not have access.';
  }
  if (/exceeds GitHub's file size limit|GH001: Large files detected|file .* is .* MB/i.test(cleaned)) {
    return '[LARGE_FILE] GitHub rejected an oversized tracked file. Remove generated dependencies or use Git LFS before pushing.';
  }
  if (/Please tell me who you are|unable to auto-detect email address/i.test(cleaned)) {
    return 'Git needs your name and email before it can commit. Set them under Account & remote.';
  }
  if (/src refspec .* does not match any/i.test(cleaned)) {
    return 'There is nothing to push yet. Create a commit first.';
  }
  if (/not a git repository/i.test(cleaned)) {
    return 'That folder is not a Git repository.';
  }
  return cleaned;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
  else process.kill(pid, 'SIGKILL');
}

export function runGit(args: string[], cwd?: string, options: CommandOptions = {}): Promise<string> {
  const timeout = options.timeout ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Git Pilot's choice: let Git Credential Manager show its own sign-in UI.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '1' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT) into.push(chunk);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeout);

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(
          error.code === 'ENOENT'
            ? 'Git was not found. Install Git for Windows (it includes Git Credential Manager) and restart OMNI-STUDIO.'
            : error.message,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      if (timedOut) {
        reject(new Error(`git ${args[0]} took longer than ${Math.round(timeout / 1000)}s and was stopped.`));
        return;
      }
      if (code !== 0 && !options.allowFailure) {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(new Error(friendlyGitError(stderr || stdout.trim() || `git ${args[0]} exited with code ${code}`)));
        return;
      }
      resolve(stdout);
    });
  });
}

async function optionalGit(args: string[], cwd?: string): Promise<string> {
  try {
    return (await runGit(args, cwd)).trim();
  } catch {
    return '';
  }
}

/** Run a pathspec-taking git command over `files`, in command-line-sized batches. */
async function runForFiles(prefix: string[], files: string[], cwd: string): Promise<void> {
  let batch: string[] = [];
  let chars = 0;
  const flush = async () => {
    if (!batch.length) return;
    await runGit(['--literal-pathspecs', ...prefix, '--', ...batch], cwd);
    batch = [];
    chars = 0;
  };
  for (const file of files) {
    if (chars + file.length + 3 > BATCH_CHARS) await flush();
    batch.push(file);
    chars += file.length + 3;
  }
  await flush();
}

export async function resolveRepoRoot(folder: string): Promise<string> {
  if (typeof folder !== 'string' || !folder) throw new Error('Choose a repository folder.');
  const stat = await fs.stat(folder).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('That folder no longer exists.');
  const root = await runGit(['rev-parse', '--show-toplevel'], folder);
  return path.resolve(root.trim());
}

function changeStatus(indexCode: string, workTreeCode: string): ChangeStatus {
  const combined = `${indexCode}${workTreeCode}`;
  if (combined === '??') return 'untracked';
  if (combined.includes('U') || ['AA', 'DD'].includes(combined)) return 'conflicted';
  if (combined.includes('R')) return 'renamed';
  if (combined.includes('C')) return 'copied';
  if (combined.includes('D')) return 'deleted';
  if (combined.includes('A')) return 'added';
  if (combined.includes('M')) return 'modified';
  return 'unknown';
}

/** Text after the first `count` space-separated fields — a path may contain spaces. */
function afterFields(entry: string, count: number): string {
  let at = 0;
  for (let i = 0; i < count; i++) {
    at = entry.indexOf(' ', at) + 1;
    if (at === 0) return '';
  }
  return entry.slice(at);
}

export interface ParsedStatus {
  /** Branch name (also for an unborn branch), or '' when detached. */
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  changes: FileChange[];
}

/**
 * `git status --porcelain=v2 --branch -z`. v2 (Git Pilot used v1) carries the
 * branch, upstream and ahead/behind counts in its headers, which saves three
 * separate git calls per refresh. Change codes use "." for "unchanged"; they
 * are mapped to v1's " " so FileChange reads the same as before.
 */
export function parseStatus(raw: string): ParsedStatus {
  const entries = raw.split('\0').filter(Boolean);
  const result: ParsedStatus = { head: '', upstream: '', ahead: 0, behind: 0, changes: [] };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.startsWith('# ')) {
      const [, key = '', ...rest] = entry.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') result.head = value === '(detached)' ? '' : value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
        }
      }
      continue;
    }

    const kind = entry[0];
    let codes: string;
    let filePath: string;
    let oldPath: string | undefined;
    if (kind === '?') {
      codes = '??';
      filePath = entry.slice(2);
    } else if (kind === '1') {
      codes = entry.slice(2, 4);
      filePath = afterFields(entry, 8);
    } else if (kind === '2') {
      // A rename/copy: "2 XY … Xscore new\0old".
      codes = entry.slice(2, 4);
      filePath = afterFields(entry, 9);
      oldPath = entries[index + 1];
      index += 1;
    } else if (kind === 'u') {
      codes = entry.slice(2, 4);
      filePath = afterFields(entry, 10);
    } else {
      continue; // "!" ignored entries are never requested
    }
    if (!filePath) continue;

    const indexCode = codes[0] === '.' ? ' ' : codes[0];
    const workTreeCode = codes[1] === '.' ? ' ' : codes[1];
    result.changes.push({
      path: filePath,
      oldPath,
      indexCode,
      workTreeCode,
      staged: indexCode !== ' ' && indexCode !== '?',
      unstaged: workTreeCode !== ' ' || indexCode === '?',
      status: changeStatus(indexCode, workTreeCode),
    });
  }
  return result;
}

const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'];

const FIELD = '\x1f';
const RECORD = '\x1e';

function parseCommits(raw: string): RepoState['commits'] {
  return raw
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', shortHash = '', author = '', date = '', ...subject] = record.split(FIELD);
      return { hash, shortHash, author, date, subject: subject.join(FIELD) };
    });
}

function parseBranches(raw: string): RepoState['branches'] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [name = '', head = '', upstream = '', lastCommitDate = ''] = line.split(FIELD);
      return { name, current: head === '*', upstream, lastCommitDate };
    });
}

const nulPaths = (raw: string) => raw.split('\0').filter(Boolean);

/**
 * Explorer files from one `ls-files -t --cached --others` listing, where each
 * entry is "<tag> <path>" and the tag "?" marks an untracked file (Git Pilot
 * listed tracked and all files in two separate calls).
 */
export function buildFiles(
  lsFilesRaw: string,
  uploadedRaw: string,
  changes: FileChange[],
): { files: RepoState['files']; truncated: boolean } {
  const uploaded = new Set(nulPaths(uploadedRaw));
  const changeByPath = new Map(changes.map((change) => [change.path, change]));

  // A conflicted path is listed once per stage; the Map dedupes it.
  const tracked = new Map<string, boolean>();
  for (const entry of nulPaths(lsFilesRaw)) {
    const filePath = entry.slice(2);
    if (filePath) tracked.set(filePath, tracked.get(filePath) || entry[0] !== '?');
  }
  const all = [...tracked.keys()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  return {
    truncated: all.length > MAX_FILES,
    files: all.slice(0, MAX_FILES).map((filePath) => ({
      path: filePath,
      tracked: tracked.get(filePath) ?? false,
      uploaded: uploaded.has(filePath),
      status: changeByPath.get(filePath)?.status,
    })),
  };
}

/** `git config --get-regexp` output; the last value wins, as with `git config --get`. */
function parseIdentity(raw: string): RepoState['identity'] {
  const identity = { name: '', email: '' };
  for (const line of raw.split(/\r?\n/)) {
    const match = /^user\.(name|email) (.*)$/i.exec(line);
    if (match) identity[match[1].toLowerCase() as 'name' | 'email'] = match[2].trim();
  }
  return identity;
}

/** `git remote -v` → remotes in listing order ("name\turl (fetch|push)"). */
export function parseRemotes(raw: string): RepoState['remotes'] {
  const byName = new Map<string, { name: string; fetchUrl: string; pushUrl: string }>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(\S+)\t(.*?)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url, kind] = match;
    const remote = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') remote.fetchUrl = url;
    else remote.pushUrl = url;
    byName.set(name, remote);
  }
  return [...byName.values()].map((r) => ({ ...r, pushUrl: r.pushUrl || r.fetchUrl }));
}

export async function getRepoState(folder: string): Promise<RepoState> {
  return readState(await resolveRepoRoot(folder));
}

/** State of a repository whose root is already resolved. */
async function readState(root: string): Promise<RepoState> {
  // One parallel round of as few git calls as possible. Each spawn costs
  // ~0.1–0.2 s on Windows and concurrent spawns barely overlap, so the count
  // is what matters: Git Pilot's 12+ calls in dependent rounds took ~2 s per
  // refresh; these 7 take well under half that. `@{u}` resolves the upstream
  // inside git; an empty result just means there isn't one.
  const [statusRaw, commitsRaw, branchesRaw, remotesRaw, identityRaw, lsFilesRaw, uploadedRaw] = await Promise.all([
    runGit(STATUS_ARGS, root),
    optionalGit(['log', '-40', `--pretty=format:%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s${RECORD}`], root),
    optionalGit(
      [
        'for-each-ref',
        `--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:iso8601-strict)`,
        'refs/heads',
      ],
      root,
    ),
    optionalGit(['remote', '-v'], root),
    optionalGit(['config', '--get-regexp', '^user\\.(name|email)$'], root),
    runGit(['ls-files', '-t', '--cached', '--others', '--exclude-standard', '-z'], root),
    optionalGit(['ls-tree', '-r', '--name-only', '-z', '@{u}'], root),
  ]);

  const status = parseStatus(statusRaw);
  // v2 names the branch even before its first commit; empty means detached.
  const branch = status.head || DETACHED_HEAD;
  const branches = parseBranches(branchesRaw);
  // An unborn branch has no ref yet, so for-each-ref doesn't list it.
  if (status.head && !branches.some((b) => b.name === status.head)) {
    branches.unshift({ name: status.head, current: true, upstream: '', lastCommitDate: '' });
  }

  const { files, truncated } = buildFiles(lsFilesRaw, status.upstream ? uploadedRaw : '', status.changes);

  return {
    root,
    name: path.basename(root),
    branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    files,
    filesTruncated: truncated,
    changes: status.changes,
    commits: parseCommits(commitsRaw),
    branches,
    remotes: parseRemotes(remotesRaw),
    identity: parseIdentity(identityRaw),
  };
}

async function withState(root: string, message: string): Promise<OperationResult> {
  return { message, state: await readState(root) };
}

/** Validate a renderer-supplied selection of repository-relative paths. */
function ensureFiles(root: string, files: unknown): string[] {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Select at least one file first.');
  return files.map((file) => {
    if (typeof file !== 'string' || !file || path.isAbsolute(file)) throw new Error('Invalid file selection.');
    const target = path.resolve(root, file);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Invalid file selection.');
    return file;
  });
}

const plural = (n: number, word = 'file') => `${n} ${word}${n === 1 ? '' : 's'}`;

async function hasHead(root: string): Promise<boolean> {
  return Boolean(await optionalGit(['rev-parse', '--verify', '-q', 'HEAD'], root));
}

export async function stage(repo: string, files: string[]): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const list = ensureFiles(root, files);
  // -A so a deleted file's removal is staged too.
  await runForFiles(['add', '-A'], list, root);
  return withState(root, `Staged ${plural(list.length)}.`);
}

export async function unstage(repo: string, files: string[]): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const selection = ensureFiles(root, files);
  // A staged rename is two index entries; unstaging only the new path would
  // leave the old path's deletion staged.
  const { changes } = parseStatus(await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=no'], root));
  const list = [
    ...new Set(
      selection.flatMap((file) => {
        const oldPath = changes.find((change) => change.path === file)?.oldPath;
        return oldPath ? [file, oldPath] : [file];
      }),
    ),
  ];
  if (await hasHead(root)) await runForFiles(['restore', '--staged'], list, root);
  else await runForFiles(['rm', '--cached', '-q'], list, root);
  return withState(root, `Unstaged ${plural(selection.length)}.`);
}

export async function discard(repo: string, files: string[]): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const list = ensureFiles(root, files);
  const state = await readState(root);
  const selected = state.changes.filter((change) => list.includes(change.path));
  const untracked = selected.filter((change) => change.status === 'untracked').map((change) => change.path);
  const added = selected.filter((change) => change.status === 'added').map((change) => change.path);
  const tracked = selected
    .filter((change) => !['untracked', 'added'].includes(change.status))
    .flatMap((change) => [change.path, ...(change.oldPath ? [change.oldPath] : [])]);
  if (tracked.length) await runForFiles(['restore', '--staged', '--worktree'], tracked, root);
  if (added.length) {
    if (await hasHead(root)) await runForFiles(['restore', '--staged'], added, root);
    else await runForFiles(['rm', '--cached', '-q'], added, root);
  }
  const filesToDelete = [...untracked, ...added];
  if (filesToDelete.length) await runForFiles(['clean', '-f'], filesToDelete, root);
  return withState(root, `Discarded changes in ${plural(list.length)}.`);
}

export async function commit(repo: string, message: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const cleanMessage = String(message ?? '').trim();
  if (!cleanMessage) throw new Error('Enter a commit message.');
  await runGit(['commit', '-m', cleanMessage], root);
  return withState(root, 'Commit created successfully.');
}

export async function fetchRepo(repo: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  await runGit(['fetch', '--all', '--prune'], root, { timeout: 300_000 });
  return withState(root, 'Fetched the latest remote updates.');
}

export async function pullRepo(repo: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  // Fast-forward only: never an unexpected merge commit.
  await runGit(['pull', '--ff-only'], root, { timeout: 300_000 });
  return withState(root, 'Pulled the latest changes.');
}

/** Largest file in HEAD's tree at or over GitHub's 100 MB hard limit, if any. */
export function findOversized(lsTree: string): { path: string; bytes: number } | undefined {
  return lsTree
    .split(/\r?\n/)
    .map((line) => line.match(/^\d+\s+blob\s+\w+\s+(\d+)\t(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ bytes: Number.parseInt(match[1], 10), path: match[2] }))
    .find((file) => file.bytes >= LARGE_FILE_BYTES);
}

export async function pushRepo(repo: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const state = await readState(root);
  if (!state.remotes.length) throw new Error('Add a remote before pushing.');
  if (state.branch === DETACHED_HEAD) throw new Error('Switch to a branch before pushing.');
  const oversized = findOversized(await optionalGit(['ls-tree', '-rl', 'HEAD'], root));
  if (oversized) {
    const size = (oversized.bytes / (1024 * 1024)).toFixed(1);
    throw new Error(
      `[LARGE_FILE] Push blocked: ${oversized.path} is ${size} MB. GitHub does not accept regular Git files of 100 MB or larger.`,
    );
  }

  const pushArgs = state.upstream ? ['push'] : ['push', '--set-upstream', state.remotes[0].name, state.branch];
  try {
    await runGit(pushArgs, root, { timeout: 300_000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('[AUTH_REQUIRED]')) throw error;
    // No stored credential: sign in through Git Credential Manager, then retry once.
    await signIn(root);
    await runGit(pushArgs, root, { timeout: 300_000 });
  }
  return withState(root, 'Changes pushed successfully.');
}

/** A branch name as the user typed it, checked by git and kept from parsing as an option. */
async function checkBranchName(root: string, raw: unknown, what = 'a branch name'): Promise<string> {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error(`Enter ${what}.`);
  if (name.startsWith('-')) throw new Error('Branch names cannot start with "-".');
  await runGit(['check-ref-format', '--branch', name], root).catch(() => {
    throw new Error(`"${name}" is not a valid branch name.`);
  });
  return name;
}

async function localBranchExists(root: string, name: string): Promise<boolean> {
  return Boolean(await optionalGit(['show-ref', '--verify', `refs/heads/${name}`], root));
}

export async function switchBranch(repo: string, branch: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const name = await checkBranchName(root, branch, 'a branch');
  if (!(await localBranchExists(root, name))) throw new Error(`The branch ${name} no longer exists.`);
  await runGit(['switch', name], root);
  return withState(root, `Switched to ${name}.`);
}

export async function createBranch(repo: string, branch: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const name = await checkBranchName(root, branch);
  await runGit(['switch', '-c', name], root);
  return withState(root, `Created and switched to ${name}.`);
}

export async function mergeBranch(repo: string, sourceBranch: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const source = await checkBranchName(root, sourceBranch, 'a branch to merge');
  if (!(await localBranchExists(root, source))) throw new Error(`The branch ${source} no longer exists.`);

  const state = await readState(root);
  if (state.branch === DETACHED_HEAD) throw new Error('Switch to a branch before merging.');
  if (state.branch === source) throw new Error('Choose a different branch to merge into the current branch.');
  if (state.changes.length) throw new Error('Commit or discard your working changes before merging branches.');

  let output = '';
  try {
    output = await runGit(['merge', '--no-edit', source], root, { timeout: 300_000 });
  } catch (error) {
    const mergeHead = await optionalGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root);
    if (!mergeHead) throw error;
    try {
      await runGit(['merge', '--abort'], root);
    } catch {
      throw new Error(
        'The merge failed and could not be rolled back automatically. Open the terminal to review the repository state.',
      );
    }
    throw new Error(
      `The branches contain conflicting changes. Git Studio aborted the merge, so ${state.branch} was left unchanged.`,
    );
  }

  const alreadyMerged = /already up[ -]to[ -]date/i.test(output);
  return withState(
    root,
    alreadyMerged
      ? `${state.branch} already contains all changes from ${source}.`
      : `Merged ${source} into ${state.branch}. Push ${state.branch} when you are ready to publish it.`,
  );
}

export async function addRemote(repo: string, name: string, url: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const cleanName = String(name ?? '').trim();
  const cleanUrl = String(url ?? '').trim();
  if (!cleanName || !cleanUrl) throw new Error('Remote name and URL are required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleanName)) {
    throw new Error('Use letters, numbers, dots, hyphens and underscores for the remote name.');
  }
  if (cleanUrl.startsWith('-')) throw new Error('That is not a valid remote URL.');
  const existing = (await optionalGit(['remote'], root)).split(/\r?\n/).includes(cleanName);
  if (existing) await runGit(['remote', 'set-url', cleanName, cleanUrl], root);
  else await runGit(['remote', 'add', cleanName, cleanUrl], root);
  return withState(root, existing ? `Updated ${cleanName}.` : `Added ${cleanName}.`);
}

export async function saveIdentity(
  repo: string,
  identity: { name: string; email: string },
  global: boolean,
): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const name = String(identity?.name ?? '').trim();
  const email = String(identity?.email ?? '').trim();
  if (!name || !email) throw new Error('Your name and email are both required.');
  const prefix = global ? ['config', '--global'] : ['config'];
  await runGit([...prefix, 'user.name', name], root);
  await runGit([...prefix, 'user.email', email], root);
  return withState(root, `Git identity saved ${global ? 'globally' : 'for this repository'}.`);
}

export async function authInfo(): Promise<{
  credentialManagerInstalled: boolean;
  credentialManagerVersion: string;
  helper: string;
}> {
  const helper = await optionalGit(['config', '--global', '--get', 'credential.helper']);
  let credentialManagerVersion = '';
  try {
    credentialManagerVersion = (await runGit(['credential-manager', '--version'], undefined, { timeout: 10_000 })).trim();
  } catch {
    // Git can still authenticate through another configured helper.
  }
  return {
    credentialManagerInstalled: Boolean(credentialManagerVersion || /manager/i.test(helper)),
    credentialManagerVersion,
    helper,
  };
}

export async function signIn(repo: string): Promise<OperationResult> {
  const root = await resolveRepoRoot(repo);
  const state = await readState(root);
  const remote = state.remotes[0];
  if (!remote) throw new Error('Add a remote first so Git Studio knows which service to sign in to.');
  const url = remote.fetchUrl.toLowerCase();

  // Git Credential Manager opens the browser / Windows sign-in UI itself and
  // stores the result in Windows Credential Manager — nothing passes through here.
  if (url.includes('github.com')) {
    await runGit(['credential-manager', 'github', 'login'], root, { timeout: 300_000 });
  } else if (url.includes('gitlab.com')) {
    await runGit(['credential-manager', 'gitlab', 'login'], root, { timeout: 300_000 });
  } else {
    await runGit(['ls-remote', remote.name, 'HEAD'], root, { timeout: 300_000 });
  }
  return withState(root, 'Authentication completed. Git stores the credential securely in Windows Credential Manager.');
}

/** Folder name git would pick for a clone URL. */
export function inferCloneName(url: string): string {
  return url.replace(/[\\/]+$/, '').split(/[\\/:]/).pop()?.replace(/\.git$/i, '') || 'repository';
}

export async function cloneRepository(url: string, parent: string, requestedName?: string): Promise<RepoState> {
  const cleanUrl = String(url ?? '').trim();
  if (!cleanUrl) throw new Error('Enter a repository URL.');
  if (cleanUrl.startsWith('-')) throw new Error('That is not a valid repository URL.');
  const parentStat = await fs.stat(String(parent ?? '')).catch(() => null);
  if (!parentStat?.isDirectory()) throw new Error('Choose a valid destination folder.');

  const name = (requestedName?.trim() || inferCloneName(cleanUrl)).trim();
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name) || name.startsWith('-')) {
    throw new Error('Enter a valid folder name.');
  }
  const destination = path.resolve(parent, name);
  if (path.dirname(destination).toLowerCase() !== path.resolve(parent).toLowerCase()) throw new Error('Invalid destination.');
  if (await fs.stat(destination).catch(() => null)) {
    const entries = await fs.readdir(destination).catch(() => ['?']);
    if (entries.length) throw new Error(`${name} already exists in that folder and is not empty.`);
  }
  // `--` so the URL can never be read as an option.
  await runGit(['clone', '--', cleanUrl, name], parent, { timeout: 600_000 });
  return getRepoState(destination);
}

export async function initRepository(folder: string): Promise<RepoState> {
  const stat = await fs.stat(String(folder ?? '')).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('Choose a valid folder.');
  await runGit(['init'], folder);
  return getRepoState(folder);
}
