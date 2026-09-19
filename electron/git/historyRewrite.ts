// Removing credentials from a repository: the files as they are now, and the
// history behind them.
//
// The history is rewritten with git's own plumbing rather than filter-branch:
// only the blobs that actually contain a secret are rewritten, every commit
// keeps its message, author, committer and dates, and commits from before the
// secret appeared keep their original hashes. A bundle of the old history is
// written first, so the rewrite can always be undone.
//
// What this cannot undo: copies already pushed elsewhere. A removed credential
// must still be treated as leaked and rotated.

import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './gitService';
import { MAX_BLOB_BYTES } from './secretScan';

export const REPLACEMENT = '***REMOVED***';

export interface RemovalSummary {
  /** Bundle holding the history as it was before the rewrite. */
  backupPath: string;
  filesChanged: string[];
  blobsRewritten: number;
  commitsRewritten: number;
  refsUpdated: string[];
  /** Annotated/signed tags still pointing at old commits (left alone). */
  tagsSkipped: string[];
  /** Commits whose GPG signature had to be dropped because their content changed. */
  signaturesDropped: number;
  historyRewritten: boolean;
}

/** git with data on stdin, returning raw bytes (for cat-file / hash-object / mktree). */
function gitIn(args: string[], cwd: string, input?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`git ${args[0]} failed: ${Buffer.concat(err).toString('utf8').trim()}`)),
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const replaceAll = (text: string, values: string[]) =>
  values.reduce((acc, value) => (value ? acc.split(value).join(REPLACEMENT) : acc), text);

const containsAny = (text: string, values: string[]) => values.some((v) => v && text.includes(v));

const nul = (raw: string) => raw.split('\0').filter(Boolean);

/** Replace the values in the files on disk (tracked and untracked). */
async function scrubWorkingTree(root: string, values: string[]): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(['ls-files', '-z'], root),
    runGit(['ls-files', '-z', '--others', '--exclude-standard'], root),
  ]);
  const changed: string[] = [];
  for (const rel of [...new Set([...nul(tracked), ...nul(untracked)])]) {
    const abs = path.join(root, rel);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > MAX_BLOB_BYTES) continue;
    const buf = await readFile(abs).catch(() => null);
    if (!buf || buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString('utf8');
    if (!containsAny(text, values)) continue;
    await writeFile(abs, replaceAll(text, values), 'utf8');
    changed.push(rel);
  }
  return changed;
}

/** Old blob → rewritten blob, for every blob in the history holding a secret. */
async function rewriteBlobs(root: string, values: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const objects = (await runGit(['rev-list', '--objects', '--all'], root)).split(/\r?\n/);
  const seen = new Set<string>();
  for (const line of objects) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const sha = line.slice(0, space);
    if (seen.has(sha)) continue;
    seen.add(sha);
    const size = Number((await runGit(['cat-file', '-s', sha], root).catch(() => '0')).trim());
    if (!size || size > MAX_BLOB_BYTES) continue;
    const content = await gitIn(['cat-file', 'blob', sha], root).catch(() => null);
    if (!content || content.subarray(0, 8000).includes(0)) continue;
    const text = content.toString('utf8');
    if (!containsAny(text, values)) continue;
    const newSha = (await gitIn(['hash-object', '-w', '--stdin'], root, Buffer.from(replaceAll(text, values), 'utf8')))
      .toString('utf8')
      .trim();
    map.set(sha, newSha);
  }
  return map;
}

/** Rewrite a tree recursively, reusing the original when nothing inside changed. */
async function rewriteTree(root: string, tree: string, blobs: Map<string, string>, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(tree);
  if (cached) return cached;
  const raw = (await gitIn(['ls-tree', '-z', tree], root)).toString('utf8');
  let changed = false;
  const entries: string[] = [];
  for (const entry of nul(raw)) {
    const tab = entry.indexOf('\t');
    const [mode, type, sha] = entry.slice(0, tab).split(' ');
    const name = entry.slice(tab + 1);
    let next = sha;
    if (type === 'blob' && blobs.has(sha)) next = blobs.get(sha)!;
    else if (type === 'tree') next = await rewriteTree(root, sha, blobs, cache);
    if (next !== sha) changed = true;
    entries.push(`${mode} ${type} ${next}\t${name}`);
  }
  const result = changed ? (await gitIn(['mktree', '-z'], root, entries.join('\0') + '\0')).toString('utf8').trim() : tree;
  cache.set(tree, result);
  return result;
}

interface CommitParts {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
  signed: boolean;
}

/** Split a raw commit object into the parts commit-tree needs back. */
export function parseCommit(raw: string): CommitParts {
  const split = raw.indexOf('\n\n');
  const header = raw.slice(0, split);
  const message = raw.slice(split + 2);
  const parts: CommitParts = { tree: '', parents: [], authorLine: '', committerLine: '', message, signed: false };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) parts.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parts.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) parts.authorLine = line.slice(7);
    else if (line.startsWith('committer ')) parts.committerLine = line.slice(10);
    else if (line.startsWith('gpgsig')) parts.signed = true;
  }
  return parts;
}

/** "Name <email> 1699999999 +0530" → the three env values git wants. */
export function identityEnv(line: string, prefix: 'AUTHOR' | 'COMMITTER'): Record<string, string> {
  const match = /^(.*) <([^>]*)> (\d+ [+-]\d{4})$/.exec(line.trim());
  if (!match) return {};
  return {
    [`GIT_${prefix}_NAME`]: match[1],
    [`GIT_${prefix}_EMAIL`]: match[2],
    [`GIT_${prefix}_DATE`]: match[3],
  };
}

function commitTree(root: string, tree: string, parents: string[], message: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p])];
    const child = spawn('git', args, { cwd: root, windowsHide: true, env: { ...process.env, ...env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString('utf8').trim())
        : reject(new Error(`git commit-tree failed: ${Buffer.concat(err).toString('utf8').trim()}`)),
    );
    child.stdin.end(message, 'utf8');
  });
}

/**
 * Remove `values` from the working tree and from every commit that contains
 * them. Returns what changed; the caller shows it and offers the force-push.
 */
export async function removeSecrets(repo: string, values: string[]): Promise<RemovalSummary> {
  const root = path.resolve((await runGit(['rev-parse', '--show-toplevel'], repo)).trim());
  const clean = [...new Set(values.map((v) => String(v ?? '')).filter((v) => v.length >= 6))];
  if (!clean.length) throw new Error('Nothing selected to remove.');

  // 1. Backup the whole history first — this is the undo.
  const backupDir = path.join(root, '.git', 'imaginarium-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `before-secret-removal-${new Date().toISOString().replace(/[:.]/g, '-')}.bundle`);
  const hasCommits = Boolean((await runGit(['rev-list', '-n', '1', '--all'], root).catch(() => '')).trim());
  if (hasCommits) await runGit(['bundle', 'create', backupPath, '--all'], root, { timeout: 600_000 });

  // 2. The files as they are now.
  const filesChanged = await scrubWorkingTree(root, clean);

  // 3. The history.
  const blobs = hasCommits ? await rewriteBlobs(root, clean) : new Map<string, string>();
  const summary: RemovalSummary = {
    backupPath: hasCommits ? backupPath : '',
    filesChanged,
    blobsRewritten: blobs.size,
    commitsRewritten: 0,
    refsUpdated: [],
    tagsSkipped: [],
    signaturesDropped: 0,
    historyRewritten: false,
  };
  if (!blobs.size) return summary;

  const order = (await runGit(['rev-list', '--reverse', '--topo-order', '--all'], root)).split(/\r?\n/).filter(Boolean);
  const mapped = new Map<string, string>();
  const treeCache = new Map<string, string>();

  for (const sha of order) {
    const raw = (await gitIn(['cat-file', 'commit', sha], root)).toString('utf8');
    const parts = parseCommit(raw);
    const newTree = await rewriteTree(root, parts.tree, blobs, treeCache);
    const newParents = parts.parents.map((p) => mapped.get(p) ?? p);
    const parentsChanged = newParents.some((p, i) => p !== parts.parents[i]);
    if (newTree === parts.tree && !parentsChanged) continue; // untouched commit keeps its hash
    const env = { ...identityEnv(parts.authorLine, 'AUTHOR'), ...identityEnv(parts.committerLine, 'COMMITTER') };
    const newSha = await commitTree(root, newTree, newParents, parts.message, env);
    mapped.set(sha, newSha);
    summary.commitsRewritten++;
    if (parts.signed) summary.signaturesDropped++; // the old signature can't cover new content
  }

  // 4. Point the refs at the rewritten commits.
  const refs = (await runGit(['for-each-ref', '--format=%(refname) %(objecttype) %(objectname)'], root)).split(/\r?\n/);
  for (const line of refs.filter(Boolean)) {
    const [refname, type, objectname] = line.trim().split(' ');
    if (refname.startsWith('refs/remotes/')) continue; // updated by the next fetch/push
    if (type === 'tag') {
      if (summary.commitsRewritten) summary.tagsSkipped.push(refname);
      continue; // annotated tag: rewriting would break its own signature/metadata
    }
    const next = mapped.get(objectname);
    if (!next) continue;
    await runGit(['update-ref', refname, next], root);
    summary.refsUpdated.push(refname);
  }

  // 5. Keep the working tree and index exactly as they are, on the new HEAD.
  const head = (await runGit(['rev-parse', 'HEAD'], root).catch(() => '')).trim();
  if (head && mapped.has(head)) await runGit(['reset', '--soft', mapped.get(head)!], root);

  // 6. Drop the old objects locally (the bundle is the backup).
  await runGit(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], root).catch(() => {});
  await runGit(['gc', '--prune=now', '--quiet'], root, { timeout: 600_000 }).catch(() => {});

  summary.historyRewritten = true;
  return summary;
}

/**
 * Publish a rewritten branch. --force-with-lease so a push is refused if the
 * remote moved since the last fetch (someone else pushed meanwhile).
 */
export async function forcePush(repo: string, remote: string, branch: string): Promise<string> {
  const root = path.resolve((await runGit(['rev-parse', '--show-toplevel'], repo)).trim());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error('Invalid remote name.');
  if (!branch || branch.startsWith('-')) throw new Error('Invalid branch name.');
  await runGit(['check-ref-format', '--branch', branch], root);
  try {
    await runGit(['push', '--force-with-lease', remote, branch], root, { timeout: 600_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/stale info|fetch first|rejected/i.test(message)) {
      throw new Error(
        `${remote} has commits your copy doesn't (someone else pushed). Fetch and re-check before forcing: ${message}`,
      );
    }
    throw err;
  }
  return `Force-pushed ${branch} to ${remote}.`;
}
