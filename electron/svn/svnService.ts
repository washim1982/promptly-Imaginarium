// SVN operations, ported from SVN Studio's web/server/src/services/svnService.ts.
// The Express routes are gone — electron/svn/ipc.ts calls these directly — but
// the svn invocations and XML parsing are unchanged except where noted.

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
  // NOTE: --password on argv is visible to other local processes. For hardened
  // setups, seed svn's own auth cache once instead of storing a password here.
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

// ---- status ----------------------------------------------------------------

// `svn status --xml` reports wc-status `item` as a full word ("added", ...), not
// the single-letter codes of the plain-text output.
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

  // FIX vs SVN Studio: it read `wc-status@kind`, but `svn status --xml` never
  // emits a kind attribute (only item/props/revision), so every entry came back
  // as a file — a new local folder rendered as a leaf *plus* a duplicate
  // directory node for its children. The filesystem is the reliable source; a
  // path gone from disk (deleted/missing) is resolved with `svn info` in getTree.
  return Promise.all(
    entries.map(async (entry) => {
      const wcStatus = entry['wc-status'];
      // The working-copy root reports as "." (e.g. an svn:ignore change on it);
      // the rest of the app addresses the root as "".
      const raw = toPosix(entry['@_path']);
      const rel = raw === '.' ? '' : raw;
      const st = await stat(abs(settings, rel)).catch(() => null);
      // FIX vs SVN Studio: a property-only change (e.g. setting svn:ignore)
      // reports item="normal" props="modified". Reading only `item` made those
      // changes invisible — nothing to see, and nothing you could commit.
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

// ---- tree (working copy on disk, overlaid with svn status) --------------------

/**
 * The Explorer tree.
 *
 * FIX vs SVN Studio: it built the tree from `svn list -R <wc>`, which queries the
 * *repository* at the working-copy root's BASE revision. Committing specific
 * paths doesn't bump the root (mixed revisions), so files you had just committed
 * vanished from the Explorer until you ran Update — and a fresh checkout of a
 * new repository showed nothing but local changes. It also cost a network round
 * trip on every refresh.
 *
 * The Explorer now shows the working copy itself: the folder on disk, with
 * `svn status` overlaid for per-item state. Deleted and missing items — tracked
 * by svn but gone from disk — are folded back in from status so they can still
 * be committed or reverted. Ignored items (svn:ignore) are left out, as the
 * original's repository listing never contained them either.
 */
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
    // A property change on the root itself (typically svn:ignore) — kept on the
    // root node rather than rendered as a bogus "." folder.
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
      // An unversioned folder is one change; svn reports it, not its contents.
      // Still walk it so its files can be opened and reviewed.
      if (isDirectory) await walk(rel, node);
    }
  }
  await walk('', root);

  // Items svn tracks that are no longer on disk (deleted / missing).
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
    // Parents before children, so a deleted folder becomes one directory node.
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

/**
 * Node kind for paths that aren't on disk. `svn info` answers from the working
 * copy database, so this needs no network access — one call for all of them.
 */
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

// ---- file content --------------------------------------------------------------

/**
 * What the editor shows for a file.
 *
 * FIX vs SVN Studio: it used `svn cat` first, but for a working-copy path that
 * returns the BASE revision, not the file on disk. A locally modified file would
 * open showing its old content — and saving in edit mode would then overwrite the
 * uncommitted changes with BASE plus the edit. The working file is the truth;
 * `svn cat` is only the fallback for files deleted or missing from disk.
 */
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

// ---- mutations -------------------------------------------------------------------

export async function addPath(settings: SvnSettings, relativePath: string, force = false): Promise<void> {
  // --force tolerates items that are already versioned (re-importing a file that
  // exists) instead of failing the whole operation.
  const args = ['add', '--parents', ...(force ? ['--force'] : []), abs(settings, relativePath)];
  assertOk(await svn(settings, args, settings.workingCopyPath), 'add');
}

export async function createFile(settings: SvnSettings, relativePath: string): Promise<void> {
  const absPath = abs(settings, relativePath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, '', { flag: 'wx' }); // never clobber an existing file
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
  // FIX vs SVN Studio: `svn commit` rejects unversioned targets ("not under
  // version control") and can't commit a file deleted outside svn ("missing").
  // SVN Studio listed both as ordinary changes, so ticking one made every commit
  // fail. Do what TortoiseSVN does: add the unversioned ones, schedule the
  // missing ones for deletion, then commit.
  const statusList = await getStatus(settings);
  const byPath = new Map(statusList.map((e) => [e.path, e.status]));

  // FIX vs SVN Studio: committing a folder recurses into it, so a change you
  // had *unticked* inside a ticked folder was committed anyway. Refuse rather
  // than commit something the user deselected.
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

  // FIX vs SVN Studio: plain `svn log <wc-path>` starts at the path's BASE
  // revision. Committing specific paths doesn't bump the working-copy root
  // (mixed revisions), so History never showed your own commit until you ran
  // Update — and on a fresh checkout of a new repo it was empty. Ask for
  // HEAD:1 so History reflects the repository; fall back to the old form for a
  // path that no longer exists at HEAD (deleted or moved upstream).
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

/**
 * One combined diff for AI review. Directories are skipped — a checked folder's
 * changed contents are already listed individually. Files with no `svn diff`
 * output (e.g. unversioned) are included as full content.
 */
export async function getReviewDiff(settings: SvnSettings, relativePaths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const relativePath of relativePaths) {
    const absPath = abs(settings, relativePath);
    const st = await stat(absPath).catch(() => null); // null = deleted, still diffable
    if (st?.isDirectory()) continue;
    const diff = await getDiff(settings, relativePath);
    if (diff.trim()) {
      parts.push(diff);
    } else if (st) {
      const content = await readFile(absPath, 'utf8').catch(() => '');
      if (content && !content.includes(String.fromCharCode(0))) { // NUL → binary
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

// ---- import (replaces SVN Studio's multipart upload) -----------------------------

/**
 * Copy files or folders from anywhere on disk into `targetFolder` and `svn add`
 * them. Replaces the web build's multer upload: on the desktop the renderer can
 * hand over real paths (native picker or drag-and-drop), so nothing needs to be
 * streamed through a temp directory.
 *
 * `resolveTarget` is the caller's path-safety check, applied to every destination.
 */
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

    // Copying a folder into its own subtree would recurse forever.
    if (st.isDirectory() && (dest === src || dest.startsWith(src + path.sep))) {
      throw new Error(`Cannot copy "${path.basename(src)}" into itself.`);
    }

    await mkdir(path.dirname(dest), { recursive: true });
    if (dest !== src) {
      await cp(src, dest, {
        recursive: true,
        force: true,
        // Never drag another working copy's metadata into this one.
        filter: (s) => path.basename(s) !== '.svn',
      });
    }
    await addPath(settings, relative, true);
    added.push(relative);
  }
  return added;
}
