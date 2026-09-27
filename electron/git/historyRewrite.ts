
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './gitService';
import { MAX_BLOB_BYTES } from './secretScan';

export const REPLACEMENT = '***REMOVED***';

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

export async function removeSecrets(repo: string, values: string[]): Promise<RemovalSummary> {
  const root = path.resolve((await runGit(['rev-parse', '--show-toplevel'], repo)).trim());
  const clean = [...new Set(values.map((v) => String(v ?? '')).filter((v) => v.length >= 6))];
  if (!clean.length) throw new Error('Nothing selected to remove.');

  const backupDir = path.join(root, '.git', 'imaginarium-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `before-secret-removal-${new Date().toISOString().replace(/[:.]/g, '-')}.bundle`);
  const hasCommits = Boolean((await runGit(['rev-list', '-n', '1', '--all'], root).catch(() => '')).trim());
  if (hasCommits) await runGit(['bundle', 'create', backupPath, '--all'], root, { timeout: 600_000 });

  const filesChanged = await scrubWorkingTree(root, clean);

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
    if (newTree === parts.tree && !parentsChanged) continue;
    const env = { ...identityEnv(parts.authorLine, 'AUTHOR'), ...identityEnv(parts.committerLine, 'COMMITTER') };
    const newSha = await commitTree(root, newTree, newParents, parts.message, env);
    mapped.set(sha, newSha);
    summary.commitsRewritten++;
    if (parts.signed) summary.signaturesDropped++;
  }

  const refs = (await runGit(['for-each-ref', '--format=%(refname) %(objecttype) %(objectname)'], root)).split(/\r?\n/);
  for (const line of refs.filter(Boolean)) {
    const [refname, type, objectname] = line.trim().split(' ');
    if (refname.startsWith('refs/remotes/')) continue;
    if (type === 'tag') {
      if (summary.commitsRewritten) summary.tagsSkipped.push(refname);
      continue;
    }
    const next = mapped.get(objectname);
    if (!next) continue;
    await runGit(['update-ref', refname, next], root);
    summary.refsUpdated.push(refname);
  }

  const head = (await runGit(['rev-parse', 'HEAD'], root).catch(() => '')).trim();
  if (head && mapped.has(head)) await runGit(['reset', '--soft', mapped.get(head)!], root);

  await runGit(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], root).catch(() => {});
  await runGit(['gc', '--prune=now', '--quiet'], root, { timeout: 600_000 }).catch(() => {});

  summary.historyRewritten = true;
  return summary;
}

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
