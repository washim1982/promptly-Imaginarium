
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { runSvn } from './svnCli';
import type {
  CommandResult,
  SvnLogEntry,
  SvnSettings,
  SvnStatusEntry,
  SvnTreeNode,
} from './types';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function svn(settings: SvnSettings, args: string[], cwd?: string): Promise<CommandResult> {
  return runSvn(settings.svnPath, args, cwd);
}

function authArgs(settings: SvnSettings): string[] {
  const args = ['--non-interactive', '--trust-server-cert'];
  if (settings.username) args.push('--username', settings.username);
  if (settings.password) args.push('--password', settings.password);
  return args;
}

function assertOk(result: CommandResult, action: string): void {
  if (result.code !== 0) {
    throw new Error(`svn ${action} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

const toPosix = (p: string) => p.split(path.sep).join('/');
const abs = (settings: SvnSettings, rel: string) => path.join(settings.workingCopyPath, rel);


const VALID_ITEM_STATUSES = new Set<SvnStatusEntry['status']>([
  'normal', 'modified', 'added', 'deleted', 'unversioned', 'missing',
  'replaced', 'conflicted', 'ignored', 'external', 'incomplete', 'merged', 'obstructed',
]);

function parseItemStatus(item: string | undefined): SvnStatusEntry['status'] {
  if (item && (VALID_ITEM_STATUSES as Set<string>).has(item)) {
    return item as SvnStatusEntry['status'];
  }
  return 'normal';
}

const asArray = <T>(v: T | T[] | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);

export async function getStatus(settings: SvnSettings, includeIgnored = false): Promise<SvnStatusEntry[]> {
  const result = await svn(
    settings,
    ['status', '--xml', ...(includeIgnored ? ['--no-ignore'] : [])],
    settings.workingCopyPath,
  );
  assertOk(result, 'status');
  const parsed = xmlParser.parse(result.stdout);
  const entries = asArray<any>(parsed?.status?.target?.entry);

  return Promise.all(
    entries.map(async (entry) => {
      const wcStatus = entry['wc-status'];
      const raw = toPosix(entry['@_path']);
      const rel = raw === '.' ? '' : raw;
      const st = await stat(abs(settings, rel)).catch(() => null);
      let status = parseItemStatus(wcStatus?.['@_item']);
      if (status === 'normal' && wcStatus?.['@_props'] === 'modified') status = 'modified';
      if (wcStatus?.['@_props'] === 'conflicted') status = 'conflicted';
      return {
        path: rel,
        status,
        locked: Boolean(wcStatus?.['@_locked'] === 'true' || wcStatus?.lock),
        revision: wcStatus?.['@_revision'],
        isDirectory: Boolean(st?.isDirectory()),
      };
    }),
  );
}


export async function getTree(settings: SvnSettings): Promise<SvnTreeNode> {
  const statusEntries = await getStatus(settings, true);
  const ignored = new Set(statusEntries.filter((e) => e.status === 'ignored').map((e) => e.path));
  const statusMap = new Map(
    statusEntries.filter((e) => e.status !== 'ignored' && e.path !== '').map((e) => [e.path, e]),
  );

  const root: SvnTreeNode = {
    path: '',
    name: '/',
    isDirectory: true,
    status: statusEntries.find((e) => e.path === '')?.status ?? 'normal',
    locked: false,
    children: [],
  };
  const nodes = new Map<string, SvnTreeNode>([['', root]]);

  async function walk(relDir: string, parent: SvnTreeNode): Promise<void> {
    const entries = await readdir(abs(settings, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.svn') continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (ignored.has(rel)) continue;
      const isDirectory = entry.isDirectory();
      const st = statusMap.get(rel);
      const node: SvnTreeNode = {
        path: rel,
        name: entry.name,
        isDirectory,
        status: st?.status ?? 'normal',
        locked: st?.locked ?? false,
        revision: st?.revision,
        children: isDirectory ? [] : undefined,
      };
      parent.children!.push(node);
      nodes.set(rel, node);
      if (isDirectory) await walk(rel, node);
    }
  }
  await walk('', root);

  const offDisk = [...statusMap.values()].filter((e) => !nodes.has(e.path));
  if (offDisk.length > 0) {
    const kinds = await kindsOf(settings, offDisk.map((e) => e.path));
    const ensureDir = (dirPath: string): SvnTreeNode => {
      const existing = nodes.get(dirPath);
      if (existing) return existing;
      const parent = ensureDir(dirPath.split('/').slice(0, -1).join('/'));
      const node: SvnTreeNode = {
        path: dirPath,
        name: dirPath.split('/').pop()!,
        isDirectory: true,
        status: statusMap.get(dirPath)?.status ?? 'normal',
        locked: false,
        children: [],
      };
      parent.children!.push(node);
      nodes.set(dirPath, node);
      return node;
    };
    for (const e of offDisk.sort((a, b) => a.path.localeCompare(b.path))) {
      if (nodes.has(e.path)) continue;
      if (kinds.get(e.path) === 'dir') {
        ensureDir(e.path).status = e.status;
        continue;
      }
      const parent = ensureDir(e.path.split('/').slice(0, -1).join('/'));
      const node: SvnTreeNode = {
        path: e.path,
        name: e.path.split('/').pop()!,
        isDirectory: false,
        status: e.status,
        locked: e.locked,
      };
      parent.children!.push(node);
      nodes.set(e.path, node);
    }
  }

  return root;
}

async function kindsOf(settings: SvnSettings, relPaths: string[]): Promise<Map<string, string>> {
  const kinds = new Map<string, string>();
  const result = await svn(
    settings,
    ['info', '--xml', ...relPaths.map((p) => abs(settings, p))],
    settings.workingCopyPath,
  );
  const parsed = xmlParser.parse(result.stdout || '<info/>');
  const root = path.resolve(settings.workingCopyPath);
  for (const entry of asArray<any>(parsed?.info?.entry)) {
    const rel = toPosix(path.relative(root, path.resolve(root, String(entry['@_path'] ?? ''))));
    if (entry['@_kind']) kinds.set(rel, entry['@_kind']);
  }
  return kinds;
}


export async function getFileContent(settings: SvnSettings, relativePath: string): Promise<string> {
  const absPath = abs(settings, relativePath);
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    const result = await svn(settings, ['cat', absPath, ...authArgs(settings)], settings.workingCopyPath);
    assertOk(result, 'cat');
    return result.stdout;
  }
}

export async function writeFileContent(
  settings: SvnSettings,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(abs(settings, relativePath), content, 'utf8');
}


export async function addPath(settings: SvnSettings, relativePath: string, force = false): Promise<void> {
  const args = ['add', '--parents', ...(force ? ['--force'] : []), abs(settings, relativePath)];
  assertOk(await svn(settings, args, settings.workingCopyPath), 'add');
}

export async function createFile(settings: SvnSettings, relativePath: string): Promise<void> {
  const absPath = abs(settings, relativePath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, '', { flag: 'wx' });
  await addPath(settings, relativePath);
}

export async function deletePath(settings: SvnSettings, relativePath: string): Promise<void> {
  assertOk(
    await svn(settings, ['delete', '--force', abs(settings, relativePath)], settings.workingCopyPath),
    'delete',
  );
}

export async function renamePath(settings: SvnSettings, fromPath: string, toPath: string): Promise<void> {
  assertOk(
    await svn(
      settings,
      ['move', '--parents', abs(settings, fromPath), abs(settings, toPath)],
      settings.workingCopyPath,
    ),
    'move',
  );
}

export async function createFolder(settings: SvnSettings, relativePath: string): Promise<void> {
  assertOk(
    await svn(settings, ['mkdir', '--parents', abs(settings, relativePath)], settings.workingCopyPath),
    'mkdir',
  );
}

export async function commit(settings: SvnSettings, paths: string[], message: string): Promise<CommandResult> {
  const statusList = await getStatus(settings);
  const byPath = new Map(statusList.map((e) => [e.path, e.status]));

  const selected = new Set(paths);
  const willCommit = (s: string) => !['normal', 'unversioned', 'ignored', 'external'].includes(s);
  for (const target of paths) {
    const prefix = target ? `${target}/` : '';
    const dragged = statusList
      .filter((e) => e.path !== target && e.path.startsWith(prefix))
      .filter((e) => willCommit(e.status) && !selected.has(e.path))
      .map((e) => e.path);
    if (dragged.length > 0) {
      const list = dragged.slice(0, 3).join(', ') + (dragged.length > 3 ? `, +${dragged.length - 3} more` : '');
      throw new Error(
        `Committing the folder "${target || '/'}" would also commit changes you left unselected: ${list}. ` +
          'Select them too, or untick the folder.',
      );
    }
  }

  const unversioned = paths.filter((p) => byPath.get(p) === 'unversioned');
  const missing = paths.filter((p) => byPath.get(p) === 'missing');
  if (unversioned.length) {
    assertOk(
      await svn(
        settings,
        ['add', '--parents', '--force', ...unversioned.map((p) => abs(settings, p))],
        settings.workingCopyPath,
      ),
      'add',
    );
  }
  if (missing.length) {
    assertOk(
      await svn(settings, ['delete', '--force', ...missing.map((p) => abs(settings, p))], settings.workingCopyPath),
      'delete',
    );
  }

  const result = await svn(
    settings,
    ['commit', '-m', message, ...paths.map((p) => abs(settings, p)), ...authArgs(settings)],
    settings.workingCopyPath,
  );
  assertOk(result, 'commit');
  return result;
}

export async function update(settings: SvnSettings): Promise<CommandResult> {
  const result = await svn(
    settings,
    ['update', '--accept', 'postpone', ...authArgs(settings)],
    settings.workingCopyPath,
  );
  assertOk(result, 'update');
  return result;
}

export async function revert(settings: SvnSettings, paths: string[]): Promise<CommandResult> {
  const args = paths.length
    ? ['revert', ...paths.map((p) => abs(settings, p))]
    : ['revert', '-R', settings.workingCopyPath];
  const result = await svn(settings, args, settings.workingCopyPath);
  assertOk(result, 'revert');
  return result;
}

export async function getLog(settings: SvnSettings, relativePath?: string, limit = 100): Promise<SvnLogEntry[]> {
  const target = abs(settings, relativePath ?? '');
  const base = ['log', '--xml', '-v', '-l', String(limit)];

  let result = await svn(
    settings,
    [...base, '-r', 'HEAD:1', target, ...authArgs(settings)],
    settings.workingCopyPath,
  );
  if (result.code !== 0) {
    result = await svn(settings, [...base, target, ...authArgs(settings)], settings.workingCopyPath);
  }
  assertOk(result, 'log');
  const parsed = xmlParser.parse(result.stdout);
  return asArray<any>(parsed?.log?.logentry).map((entry) => ({
    revision: String(entry['@_revision']),
    author: entry.author ?? '(unknown)',
    date: entry.date,
    message: typeof entry.msg === 'string' ? entry.msg : String(entry.msg ?? ''),
    paths: asArray<any>(entry.paths?.path).map((p) => ({
      path: p['#text'] ?? p,
      action: p['@_action'],
    })),
  }));
}

export async function getDiff(settings: SvnSettings, relativePath: string): Promise<string> {
  const result = await svn(
    settings,
    ['diff', abs(settings, relativePath), ...authArgs(settings)],
    settings.workingCopyPath,
  );
  return result.stdout;
}

export async function getReviewDiff(settings: SvnSettings, relativePaths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const relativePath of relativePaths) {
    const absPath = abs(settings, relativePath);
    const st = await stat(absPath).catch(() => null);
    if (st?.isDirectory()) continue;
    const diff = await getDiff(settings, relativePath);
    if (diff.trim()) {
      parts.push(diff);
    } else if (st) {
      const content = await readFile(absPath, 'utf8').catch(() => '');
      if (content && !content.includes(String.fromCharCode(0))) {
        parts.push(`New file: ${relativePath}\n+++ ${relativePath}\n${content}`);
      }
    }
  }
  return parts.join('\n');
}

export async function lockPath(settings: SvnSettings, relativePath: string, message?: string): Promise<void> {
  const args = ['lock', abs(settings, relativePath), ...authArgs(settings)];
  if (message) args.push('-m', message);
  assertOk(await svn(settings, args, settings.workingCopyPath), 'lock');
}

export async function unlockPath(settings: SvnSettings, relativePath: string): Promise<void> {
  assertOk(
    await svn(settings, ['unlock', abs(settings, relativePath), ...authArgs(settings)], settings.workingCopyPath),
    'unlock',
  );
}

export async function checkout(settings: SvnSettings): Promise<CommandResult> {
  const result = await svn(settings, [
    'checkout',
    settings.repoUrl,
    settings.workingCopyPath,
    ...authArgs(settings),
  ]);
  assertOk(result, 'checkout');
  return result;
}

export async function isWorkingCopy(settings: SvnSettings, workingCopyPath: string): Promise<boolean> {
  const result = await svn(settings, ['info', workingCopyPath]).catch(
    () => ({ code: 1 }) as CommandResult,
  );
  return result.code === 0;
}


export async function importPaths(
  settings: SvnSettings,
  targetFolder: string,
  sources: string[],
  resolveTarget: (relative: string) => string,
): Promise<string[]> {
  const root = path.resolve(settings.workingCopyPath);
  const added: string[] = [];

  for (const source of sources) {
    const src = path.resolve(source);
    const st = await stat(src);
    const relative = resolveTarget(path.posix.join(targetFolder, path.basename(src)));
    const dest = path.resolve(root, relative);

    if (st.isDirectory() && (dest === src || dest.startsWith(src + path.sep))) {
      throw new Error(`Cannot copy "${path.basename(src)}" into itself.`);
    }

    await mkdir(path.dirname(dest), { recursive: true });
    if (dest !== src) {
      await cp(src, dest, {
        recursive: true,
        force: true,
        filter: (s) => path.basename(s) !== '.svn',
      });
    }
    await addPath(settings, relative, true);
    added.push(relative);
  }
  return added;
}
