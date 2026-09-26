// IPC surface for the Git Studio tab — Git Pilot's electron/main.ts handlers,
// moved under a git: namespace. The preload exposes them as
// window.imaginarium.git.*; the renderer's typed wrapper is src/lib/git/api.ts.

import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as git from './gitService';
import { scanRepository, scanStaged, collectCandidates } from './secretScan';
import { removeSecrets, forcePush } from './historyRewrite';
import type { RecentRepo } from './types';

const MAX_RECENT = 20;

const windowOf = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)!;

/** Literal secret values from the last scan, kept out of the renderer. */
const scans = new Map<string, { root: string; secrets: Map<string, string> }>();
const rootKey = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
function requireScan(root: string, scanId: string) {
  const scan = scans.get(scanId);
  if (!scan || rootKey(scan.root) !== rootKey(root)) {
    throw new Error('SCAN_EXPIRED: These results have expired. Scan again and review the new findings.');
  }
  return scan;
}

function recentFile(): string {
  return path.join(app.getPath('userData'), 'git-recent-repositories.json');
}

async function readRecent(): Promise<RecentRepo[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(recentFile(), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentRepo =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as RecentRepo).path === 'string' &&
          typeof (item as RecentRepo).name === 'string' &&
          typeof (item as RecentRepo).lastOpened === 'string',
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

async function writeRecent(repositories: RecentRepo[]): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(recentFile(), JSON.stringify(repositories.slice(0, MAX_RECENT), null, 2), 'utf8');
}

async function rememberRepo(root: string): Promise<void> {
  const normalized = root.toLowerCase();
  const next = [
    { path: root, name: path.basename(root), lastOpened: new Date().toISOString() },
    ...(await readRecent()).filter((repo) => repo.path.toLowerCase() !== normalized),
  ];
  await writeRecent(next);
}

/** A visible PowerShell window in the repository, showing `git status`. */
async function openPowerShell(root: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const startCommand = [
      "Start-Process -FilePath 'powershell.exe'",
      '-WorkingDirectory (Get-Location).Path',
      '-WindowStyle Normal',
      "-ArgumentList @('-NoExit', '-NoLogo', '-Command', 'git status')",
    ].join(' ');
    // The repository path is the cwd, never part of the command text.
    const launcher = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', startCommand], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true,
    });
    launcher.once('error', reject);
    launcher.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows could not open PowerShell (exit code ${code ?? 'unknown'}).`));
    });
  });
}

export function registerGitIpc(): void {
  ipcMain.handle('git:gitVersion', async () => (await git.runGit(['--version'])).trim());

  ipcMain.handle('git:openRepository', async (e) => {
    const result = await dialog.showOpenDialog(windowOf(e), {
      title: 'Choose a Git repository',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const state = await git.getRepoState(result.filePaths[0]);
    await rememberRepo(state.root);
    return state;
  });

  ipcMain.handle('git:chooseFolder', async (e) => {
    const result = await dialog.showOpenDialog(windowOf(e), {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle('git:recent', readRecent);
  ipcMain.handle('git:forget', async (_e, repoPath: string) => {
    const target = String(repoPath ?? '').toLowerCase();
    const repositories = (await readRecent()).filter((repo) => repo.path.toLowerCase() !== target);
    await writeRecent(repositories);
    return repositories;
  });
  ipcMain.handle('git:load', async (_e, repoPath: string) => {
    const state = await git.getRepoState(repoPath);
    await rememberRepo(state.root);
    return state;
  });
  ipcMain.handle('git:clone', async (_e, input: { url: string; parent: string; name?: string }) => {
    const state = await git.cloneRepository(input?.url, input?.parent, input?.name);
    await rememberRepo(state.root);
    return state;
  });
  ipcMain.handle('git:init', async (_e, folder: string) => {
    const state = await git.initRepository(folder);
    await rememberRepo(state.root);
    return state;
  });

  ipcMain.handle('git:stage', (_e, repo: string, files: string[]) => git.stage(repo, files));
  ipcMain.handle('git:unstage', (_e, repo: string, files: string[]) => git.unstage(repo, files));
  ipcMain.handle('git:discard', (_e, repo: string, files: string[]) => git.discard(repo, files));
  ipcMain.handle('git:commit', (_e, repo: string, message: string) => git.commit(repo, message));
  ipcMain.handle('git:fetch', (_e, repo: string) => git.fetchRepo(repo));
  ipcMain.handle('git:pull', (_e, repo: string) => git.pullRepo(repo));
  ipcMain.handle('git:push', (_e, repo: string) => git.pushRepo(repo));
  ipcMain.handle('git:switchBranch', (_e, repo: string, branch: string) => git.switchBranch(repo, branch));
  ipcMain.handle('git:createBranch', (_e, repo: string, branch: string) => git.createBranch(repo, branch));
  ipcMain.handle('git:mergeBranch', (_e, repo: string, source: string) => git.mergeBranch(repo, source));
  ipcMain.handle('git:addRemote', (_e, repo: string, name: string, url: string) => git.addRemote(repo, name, url));
  ipcMain.handle(
    'git:saveIdentity',
    (_e, repo: string, identity: { name: string; email: string }, global: boolean) =>
      git.saveIdentity(repo, identity, Boolean(global)),
  );
  ipcMain.handle('git:authInfo', () => git.authInfo());
  ipcMain.handle('git:signIn', (_e, repo: string) => git.signIn(repo));

  // ---- credential scan / removal ------------------------------------------------
  // The scan's literal values stay here; the renderer only ever sees masked
  // text and finding ids, and asks for removal by id.
  ipcMain.handle('git:scanSecrets', async (_e, repo: string) => {
    const root = await git.resolveRepoRoot(repo);
    const { secrets, ...result } = await scanRepository(root);
    const scanId = randomUUID();
    scans.set(scanId, { root, secrets });
    // Bound retained credential data while keeping concurrent dialogs independent.
    if (scans.size > 8) scans.delete(scans.keys().next().value!);
    return { ...result, scanId };
  });

  // Staged-only scan, for the check before a commit. Deliberately does not
  // touch full-scan sessions: these values are not in the history yet, so they must
  // never be handed to removeSecrets, which rewrites commits.
  ipcMain.handle('git:scanStaged', async (_e, repo: string) => {
    const root = await git.resolveRepoRoot(repo);
    const { secrets: _secrets, ...result } = await scanStaged(root);
    return result;
  });

  // Deep scan: lines the rules didn't match, for the local model to judge. The
  // renderer needs the text itself here — the model runs in the renderer.
  ipcMain.handle('git:scanCandidates', async (_e, repo: string, scanId: string) => {
    const root = await git.resolveRepoRoot(repo);
    const scan = requireScan(root, scanId);
    const known = new Set(scan.secrets.values());
    const result = await collectCandidates(root, known);
    // Remember each candidate's value so a confirmed one can be removed by id.
    requireScan(root, scanId);
    for (const c of result.candidates) scan.secrets.set(c.id, c.value);
    return result;
  });

  ipcMain.handle('git:removeSecrets', async (_e, repo: string, findingIds: string[], scanId: string) => {
    const root = await git.resolveRepoRoot(repo);
    const scan = requireScan(root, scanId);
    const ids = Array.isArray(findingIds) ? findingIds : [];
    if (ids.some(id => !scan.secrets.has(String(id)))) throw new Error('SCAN_EXPIRED: Selected findings are no longer available. Scan again.');
    const values = ids.map(id => scan.secrets.get(String(id))!);
    if (!values.length) throw new Error('Select at least one finding to remove.');
    // Invalidate every snapshot of this repository before mutation, including
    // duplicate submissions. A failed rewrite must be rescanned too.
    for (const [id, entry] of scans) if (rootKey(entry.root) === rootKey(root)) scans.delete(id);
    const summary = await removeSecrets(root, values);
    try {
      return { summary, state: await git.getRepoState(root) };
    } catch {
      // A refresh failure must not turn a successful rewrite into a failed action.
      return { summary, state: null, warning: 'Removal completed, but the repository view could not refresh. Reopen the repository to refresh it.' };
    }
  });

  ipcMain.handle('git:forcePush', async (_e, repo: string, remote: string, branch: string) => {
    const root = await git.resolveRepoRoot(repo);
    const message = await forcePush(root, String(remote ?? ''), String(branch ?? ''));
    return { message, state: await git.getRepoState(root) };
  });

  ipcMain.handle('git:openExplorer', async (_e, repo: string) => {
    const error = await shell.openPath(await git.resolveRepoRoot(repo));
    if (error) throw new Error(error);
  });
  ipcMain.handle('git:openTerminal', async (_e, repo: string) => {
    await openPowerShell(await git.resolveRepoRoot(repo));
  });
  ipcMain.handle('git:openCreateRemote', async (_e, repo: string) => {
    const state = await git.getRepoState(repo);
    const remote = state.remotes[0];
    if (!remote) throw new Error('Add a GitHub remote first.');
    const match = remote.fetchUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (!match) throw new Error('Automatic repository creation links are currently available for GitHub remotes.');
    await shell.openExternal(`https://github.com/new?name=${encodeURIComponent(match[2])}`);
  });
}
