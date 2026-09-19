// Git Studio, a tab of Imaginarium. Port of Git Pilot (a friendly Windows Git
// client): recent-repository sidebar, file explorer with upload indicators,
// stage / unstage / discard / commit, fetch / fast-forward pull / push, branch
// switch / create / guarded merge, history, clone and init, remote + identity
// settings, and Git Credential Manager sign-in. Git runs in the main process
// (electron/git/); this is Git Pilot's App.tsx re-skinned to the app theme.
//
// Not ported: Git Pilot's light/system theme picker (Imaginarium is dark-only
// and follows the accent from Settings) and its browser demo mode.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  Cloud,
  ExternalLink,
  GitBranch,
  GitMerge,
  KeyRound,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { errorMessage, gitApi } from '../lib/git/api';
import type { AuthInfo, OperationResult, RecentRepo, RepoState } from '../lib/git/types';
import { Modal, Spinner } from '../components/git/Modal';
import { Sidebar, Welcome } from '../components/git/Sidebar';
import { RepoWorkspace, type Tab } from '../components/git/Workspace';
import { SecretScanModal } from '../components/git/SecretScanModal';
import '../components/git/git-studio.css';

type DialogName = 'clone' | 'settings' | 'newBranch' | 'mergeBranch' | 'remoteProblem' | 'discard' | null;

const ACTIVE_REPOSITORY_KEY = 'imaginarium.git.activeRepository';
const ACTIVE_TAB_KEY = 'imaginarium.git.activeTab';

// localStorage holds per-viewer conveniences only; it can throw when storage is
// blocked, and the tab works without it.
function readStorage(key: string): string {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* still works for this session */
  }
}

function loadActiveTab(): Tab {
  const saved = readStorage(ACTIVE_TAB_KEY);
  return saved === 'history' || saved === 'branches' ? saved : 'changes';
}

export default function GitStudio() {
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const [repo, setRepo] = useState<RepoState | null>(null);
  const [hydrating, setHydrating] = useState(true);
  const [busy, setBusy] = useState(false);
  const [gitVersion, setGitVersion] = useState('');
  const [tab, setTab] = useState<Tab>(loadActiveTab);
  const [dialogName, setDialogName] = useState<DialogName>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneParent, setCloneParent] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [mergeSourceBranch, setMergeSourceBranch] = useState('');
  const [discardFiles, setDiscardFiles] = useState<string[]>([]);
  const [identityName, setIdentityName] = useState('');
  const [identityEmail, setIdentityEmail] = useState('');
  const [globalIdentity, setGlobalIdentity] = useState(true);
  const [remoteName, setRemoteName] = useState('origin');
  const [remoteUrl, setRemoteUrl] = useState('');
  // undefined while the Git Credential Manager check is running.
  const [auth, setAuth] = useState<AuthInfo | null | undefined>(undefined);
  const [scanOpen, setScanOpen] = useState(false);

  const notify = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.type === 'error' ? 7000 : 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setSelected(new Set());
  }, [repo?.root, repo?.changes.length]);

  useEffect(() => {
    if (repo) writeStorage(ACTIVE_REPOSITORY_KEY, repo.root);
  }, [repo]);

  useEffect(() => {
    writeStorage(ACTIVE_TAB_KEY, tab);
  }, [tab]);

  const refreshRecents = useCallback(async () => setRecent(await gitApi.getRecentRepositories()), []);

  const applyRepoState = useCallback((state: RepoState) => {
    setRepo(state);
    setIdentityName(state.identity.name);
    setIdentityEmail(state.identity.email);
    setRemoteName(state.remotes[0]?.name || 'origin');
    setRemoteUrl(state.remotes[0]?.fetchUrl || '');
  }, []);

  const adoptRepo = useCallback(
    async (state: RepoState | null) => {
      if (!state) return;
      applyRepoState(state);
      setTab('changes');
      setCommitMessage('');
      await refreshRecents();
    },
    [applyRepoState, refreshRecents],
  );

  // Restore the last open repository, as Git Pilot does on launch.
  useEffect(() => {
    let cancelled = false;
    const restoreSession = async () => {
      try {
        gitApi.gitVersion().then(
          (v) => !cancelled && setGitVersion(v),
          () => {},
        );
        const recentRepositories = await gitApi.getRecentRepositories();
        if (cancelled) return;
        setRecent(recentRepositories);
        const activeRepository = readStorage(ACTIVE_REPOSITORY_KEY);
        if (!activeRepository) return;
        try {
          const restored = await gitApi.loadRepository(activeRepository);
          if (!cancelled) applyRepoState(restored);
        } catch {
          writeStorage(ACTIVE_REPOSITORY_KEY, null);
        }
      } catch (error) {
        if (!cancelled) notify('error', errorMessage(error));
      } finally {
        if (!cancelled) setHydrating(false);
      }
    };
    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [applyRepoState, notify]);

  // `busy` is read through a ref so a queued action (e.g. the focus refresh)
  // never sees a stale value from the render that created it.
  const busyRef = useRef(false);
  const setBusyBoth = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  const perform = useCallback(
    async (
      work: () => Promise<OperationResult>,
      successFallback?: string,
      onError?: (rawMessage: string) => void,
    ): Promise<boolean> => {
      if (busyRef.current) return false;
      setBusyBoth(true);
      try {
        const result = await work();
        if (result.state) setRepo(result.state);
        notify('success', result.message || successFallback || 'Done.');
        return true;
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
        notify('error', errorMessage(error));
        return false;
      } finally {
        setBusyBoth(false);
      }
    },
    [notify, setBusyBoth],
  );

  const guarded = useCallback(
    async (work: () => Promise<void>) => {
      if (busyRef.current) return;
      setBusyBoth(true);
      try {
        await work();
      } catch (error) {
        notify('error', errorMessage(error));
      } finally {
        setBusyBoth(false);
      }
    },
    [notify, setBusyBoth],
  );

  const openRepository = useCallback(
    () => guarded(async () => adoptRepo(await gitApi.openRepository())),
    [adoptRepo, guarded],
  );

  const loadRepository = (repoPath: string) => guarded(async () => adoptRepo(await gitApi.loadRepository(repoPath)));

  const refresh = useCallback(
    async (silent = false) => {
      if (!repo || busyRef.current) return;
      setBusyBoth(true);
      try {
        setRepo(await gitApi.loadRepository(repo.root));
        if (!silent) notify('success', 'Repository refreshed.');
      } catch (error) {
        if (!silent) notify('error', errorMessage(error));
      } finally {
        setBusyBoth(false);
      }
    },
    [repo, notify, setBusyBoth],
  );

  // Ctrl+O opens a repository while this tab is showing.
  const openRef = useRef(openRepository);
  openRef.current = openRepository;
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void openRef.current();
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  // Files change outside the app (an editor, a terminal) — pick that up
  // quietly when the window regains focus rather than showing stale status.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const onFocus = () => void refreshRef.current(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const openSettings = async () => {
    if (repo) {
      setIdentityName(repo.identity.name);
      setIdentityEmail(repo.identity.email);
      setRemoteName(repo.remotes[0]?.name || 'origin');
      setRemoteUrl(repo.remotes[0]?.fetchUrl || '');
    }
    setDialogName('settings');
    setAuth(undefined);
    try {
      setAuth(await gitApi.authInfo());
    } catch {
      setAuth(null);
    }
  };

  const initRepo = async () => {
    if (busyRef.current) return;
    const folder = await gitApi.chooseFolder().catch(() => null);
    if (!folder) return;
    await guarded(async () => {
      await adoptRepo(await gitApi.initRepository(folder));
      notify('success', 'Repository created.');
    });
  };

  const cloneRepo = () => {
    if (!cloneUrl.trim() || !cloneParent) return;
    void guarded(async () => {
      await adoptRepo(await gitApi.cloneRepository({ url: cloneUrl, parent: cloneParent, name: cloneName || undefined }));
      setDialogName(null);
      setCloneUrl('');
      setCloneName('');
      notify('success', 'Repository cloned and ready.');
    });
  };

  // Save only what changed: Git Pilot always re-saved the identity, so adding a
  // remote was impossible until a name and email were filled in.
  const identityChanged =
    !!repo && (identityName.trim() !== repo.identity.name || identityEmail.trim() !== repo.identity.email);
  const remoteChanged =
    !!repo &&
    !!remoteUrl.trim() &&
    (remoteUrl.trim() !== (repo.remotes[0]?.fetchUrl || '') || remoteName.trim() !== (repo.remotes[0]?.name || 'origin'));
  const identityValid = !identityChanged || (!!identityName.trim() && !!identityEmail.trim());

  const saveSettings = async () => {
    if (!repo) return;
    if (identityChanged) {
      const ok = await perform(() =>
        gitApi.saveIdentity(repo.root, { name: identityName, email: identityEmail }, globalIdentity),
      );
      if (!ok) return;
    }
    if (remoteChanged) {
      const ok = await perform(() => gitApi.addRemote(repo.root, remoteName, remoteUrl));
      if (!ok) return;
    }
    setDialogName(null);
  };

  const syncRepository = (operation: 'fetch' | 'pull' | 'push') => {
    if (!repo) return;
    void perform(
      () => gitApi[operation](repo.root),
      undefined,
      operation === 'push'
        ? (rawMessage) => {
            if (rawMessage.includes('[REMOTE_NOT_FOUND]')) setDialogName('remoteProblem');
          }
        : undefined,
    );
  };

  const createBranch = () => {
    if (!repo || !branchName.trim()) return;
    void perform(() => gitApi.createBranch(repo.root, branchName)).then((ok) => {
      if (ok) {
        setDialogName(null);
        setBranchName('');
      }
    });
  };

  return (
    <div className="git-studio">
      <Sidebar
        recent={recent}
        activePath={repo?.root}
        identity={repo?.identity}
        busy={busy}
        onOpen={() => void openRepository()}
        onClone={() => setDialogName('clone')}
        onInit={() => void initRepo()}
        onSelect={(path) => void loadRepository(path)}
        onForget={(path) => void gitApi.forgetRepository(path).then(setRecent, (e) => notify('error', errorMessage(e)))}
        onSettings={() => void openSettings()}
      />

      {repo ? (
        <RepoWorkspace
          repo={repo}
          tab={tab}
          busy={busy}
          selected={selected}
          commitMessage={commitMessage}
          onTab={setTab}
          onSelected={setSelected}
          onCommitMessage={setCommitMessage}
          onStage={(files) => void perform(() => gitApi.stage(repo.root, files))}
          onUnstage={(files) => void perform(() => gitApi.unstage(repo.root, files))}
          onDiscard={(files) => {
            setDiscardFiles(files);
            setDialogName('discard');
          }}
          onCommit={() =>
            void perform(() => gitApi.commit(repo.root, commitMessage)).then((ok) => ok && setCommitMessage(''))
          }
          onSync={syncRepository}
          onRefresh={() => void refresh()}
          onSwitchBranch={(branch) =>
            branch && branch !== repo.branch && void perform(() => gitApi.switchBranch(repo.root, branch))
          }
          onMergeBranch={(branch) => {
            setMergeSourceBranch(branch);
            setDialogName('mergeBranch');
          }}
          onNewBranch={() => setDialogName('newBranch')}
          onSettings={() => void openSettings()}
          onOpenExplorer={() => void gitApi.openInExplorer(repo.root).catch((e) => notify('error', errorMessage(e)))}
          onScan={() => setScanOpen(true)}
          onOpenTerminal={() =>
            void gitApi.openTerminal(repo.root).then(
              () => notify('success', 'Terminal opened in this repository.'),
              (e) => notify('error', errorMessage(e)),
            )
          }
          onCopied={(hash) => notify('success', `Copied ${hash} to the clipboard.`)}
        />
      ) : hydrating ? (
        <main className="gs-restore-shell" aria-label="Restoring repository">
          <Spinner />
          <span>Restoring your workspace…</span>
        </main>
      ) : (
        <Welcome
          recent={recent}
          gitVersion={gitVersion}
          onOpen={() => void openRepository()}
          onClone={() => setDialogName('clone')}
          onInit={() => void initRepo()}
          onSelect={(path) => void loadRepository(path)}
        />
      )}

      {busy && (
        <div className="gs-busy-bar">
          <span />
        </div>
      )}

      {toast && (
        <div className={`gs-toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>
          {toast.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {scanOpen && repo && (
        <SecretScanModal
          repo={repo}
          onClose={() => setScanOpen(false)}
          onState={setRepo}
          onNotify={notify}
        />
      )}

      {dialogName === 'clone' && (
        <Modal title="Clone a repository" subtitle="Bring a remote project onto this computer." onClose={() => setDialogName(null)}>
          <div className="gs-modal-body gs-form-stack">
            <label>
              <span>Repository URL</span>
              <input
                autoFocus
                value={cloneUrl}
                onChange={(event) => setCloneUrl(event.target.value)}
                placeholder="https://github.com/you/project.git"
              />
            </label>
            <label>
              <span>Save inside</span>
              <div className="gs-input-action">
                <input readOnly value={cloneParent} placeholder="Choose a destination folder" />
                <button
                  type="button"
                  onClick={async () => setCloneParent((await gitApi.chooseFolder().catch(() => null)) || cloneParent)}
                >
                  Browse
                </button>
              </div>
            </label>
            <label>
              <span>
                Folder name <small>optional</small>
              </span>
              <input value={cloneName} onChange={(event) => setCloneName(event.target.value)} placeholder="Inferred from the URL" />
            </label>
            <div className="gs-info-callout">
              <ShieldCheck size={17} />
              <span>Private repository? Git Credential Manager will open your browser to sign in securely.</span>
            </div>
          </div>
          <div className="gs-modal-footer">
            <button className="gs-button secondary" onClick={() => setDialogName(null)}>
              Cancel
            </button>
            <button className="gs-button primary" disabled={!cloneUrl.trim() || !cloneParent || busy} onClick={cloneRepo}>
              {busy ? <Spinner /> : <Cloud size={16} />} Clone repository
            </button>
          </div>
        </Modal>
      )}

      {dialogName === 'newBranch' && repo && (
        <Modal title="Create a branch" subtitle={`Start a new line of work from ${repo.branch}.`} onClose={() => setDialogName(null)}>
          <div className="gs-modal-body gs-form-stack">
            <label>
              <span>Branch name</span>
              <div className="gs-input-with-icon">
                <GitBranch size={16} />
                <input
                  autoFocus
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && createBranch()}
                  placeholder="feature/my-new-work"
                />
              </div>
            </label>
            <p className="gs-field-note">
              Use letters, numbers, hyphens, and forward slashes. Git Studio will switch to this branch after creating it.
            </p>
          </div>
          <div className="gs-modal-footer">
            <button className="gs-button secondary" onClick={() => setDialogName(null)}>
              Cancel
            </button>
            <button className="gs-button primary" disabled={!branchName.trim() || busy} onClick={createBranch}>
              <GitBranch size={16} /> Create branch
            </button>
          </div>
        </Modal>
      )}

      {dialogName === 'mergeBranch' && repo && mergeSourceBranch && (
        <Modal
          title="Merge branches"
          subtitle="Bring another local branch into the branch you are currently on."
          onClose={() => setDialogName(null)}
        >
          <div className="gs-modal-body gs-merge-body">
            <div className="gs-merge-direction" aria-label={`Merge ${mergeSourceBranch} into ${repo.branch}`}>
              <div className="gs-merge-branch-card">
                <small>MERGE FROM</small>
                <strong>
                  <GitBranch size={14} /> {mergeSourceBranch}
                </strong>
              </div>
              <span className="gs-merge-direction-icon">
                <GitMerge size={18} />
              </span>
              <div className="gs-merge-branch-card target">
                <small>INTO CURRENT</small>
                <strong>
                  <Check size={14} /> {repo.branch}
                </strong>
              </div>
            </div>
            <div className="gs-info-callout">
              <ShieldCheck size={17} />
              <span>
                Your working tree must be clean. If the branches conflict, Git Studio will abort the merge automatically and
                leave <strong>{repo.branch}</strong> unchanged.
              </span>
            </div>
          </div>
          <div className="gs-modal-footer">
            <button className="gs-button secondary" onClick={() => setDialogName(null)}>
              Cancel
            </button>
            <button
              className="gs-button primary"
              disabled={busy}
              onClick={() =>
                void perform(() => gitApi.mergeBranch(repo.root, mergeSourceBranch)).then((ok) => {
                  if (ok) {
                    setDialogName(null);
                    setMergeSourceBranch('');
                  }
                })
              }
            >
              {busy ? <Spinner /> : <GitMerge size={16} />} Merge into {repo.branch}
            </button>
          </div>
        </Modal>
      )}

      {dialogName === 'discard' && repo && discardFiles.length > 0 && (
        // Replaces Git Pilot's window.confirm with the app's own dialog.
        <Modal
          title={`Discard changes in ${discardFiles.length} file${discardFiles.length === 1 ? '' : 's'}?`}
          subtitle="This cannot be undone."
          onClose={() => setDialogName(null)}
        >
          <div className="gs-modal-body">
            <ul className="gs-discard-list">
              {discardFiles.slice(0, 8).map((file) => (
                <li key={file} title={file}>
                  {file}
                </li>
              ))}
              {discardFiles.length > 8 && <li className="more">and {discardFiles.length - 8} more</li>}
            </ul>
            <div className="gs-info-callout danger">
              <Trash2 size={17} />
              <span>Edits are reverted to the last commit, and new files are deleted from disk.</span>
            </div>
          </div>
          <div className="gs-modal-footer">
            <button className="gs-button secondary" autoFocus onClick={() => setDialogName(null)}>
              Cancel
            </button>
            <button
              className="gs-button danger"
              disabled={busy}
              onClick={() =>
                void perform(() => gitApi.discard(repo.root, discardFiles)).then(() => {
                  setDialogName(null);
                  setDiscardFiles([]);
                })
              }
            >
              {busy ? <Spinner /> : <Trash2 size={16} />} Discard changes
            </button>
          </div>
        </Modal>
      )}

      {dialogName === 'settings' && (
        <Modal
          title="Account & remote"
          subtitle="Your commit identity, where this repository syncs, and how Git signs in."
          onClose={() => setDialogName(null)}
          width="wide"
        >
          <div className="gs-modal-body gs-settings-body">
            {repo ? (
              <div className="gs-settings-grid">
                <section className="gs-settings-section">
                  <div className="gs-settings-section-title">
                    <span>
                      <UserRound size={17} />
                    </span>
                    <div>
                      <h3>Commit identity</h3>
                      <p>Shown on commits you create.</p>
                    </div>
                  </div>
                  <div className="gs-form-stack compact">
                    <label>
                      <span>Your name</span>
                      <input value={identityName} onChange={(event) => setIdentityName(event.target.value)} placeholder="Ada Lovelace" />
                    </label>
                    <label>
                      <span>Email address</span>
                      <input
                        type="email"
                        value={identityEmail}
                        onChange={(event) => setIdentityEmail(event.target.value)}
                        placeholder="ada@example.com"
                      />
                    </label>
                    <label className="gs-check-label">
                      <input type="checkbox" checked={globalIdentity} onChange={(event) => setGlobalIdentity(event.target.checked)} />
                      <span>Use this identity for all repositories</span>
                    </label>
                  </div>
                </section>
                <section className="gs-settings-section">
                  <div className="gs-settings-section-title">
                    <span>
                      <Cloud size={17} />
                    </span>
                    <div>
                      <h3>Remote repository</h3>
                      <p>Where pull and push connect.</p>
                    </div>
                  </div>
                  <div className="gs-form-stack compact">
                    <label>
                      <span>Remote name</span>
                      <input value={remoteName} onChange={(event) => setRemoteName(event.target.value)} placeholder="origin" />
                    </label>
                    <label>
                      <span>Remote URL</span>
                      <input
                        value={remoteUrl}
                        onChange={(event) => setRemoteUrl(event.target.value)}
                        placeholder="https://github.com/you/project.git"
                      />
                    </label>
                  </div>
                  <AuthCard
                    auth={auth}
                    disabled={!repo.remotes.length || busy}
                    onSignIn={() => void perform(() => gitApi.signIn(repo.root))}
                  />
                </section>
              </div>
            ) : (
              <div className="gs-settings-empty">
                <AuthCard auth={auth} disabled onSignIn={() => {}} />
                <p>Open a repository to set its commit identity and remote.</p>
              </div>
            )}
          </div>
          <div className="gs-modal-footer">
            {repo ? (
              <>
                <span className="gs-secure-note">
                  <ShieldCheck size={14} /> Git Studio never stores passwords or tokens.
                </span>
                <button className="gs-button secondary" onClick={() => setDialogName(null)}>
                  Cancel
                </button>
                <button
                  className="gs-button primary"
                  disabled={(!identityChanged && !remoteChanged) || !identityValid || busy}
                  onClick={() => void saveSettings()}
                >
                  {busy ? <Spinner /> : <Check size={16} />} Save settings
                </button>
              </>
            ) : (
              <button className="gs-button primary" onClick={() => setDialogName(null)}>
                Done
              </button>
            )}
          </div>
        </Modal>
      )}

      {dialogName === 'remoteProblem' && repo && (
        <Modal
          title="Repository not found"
          subtitle="GitHub could not accept the push, but your local work is safe."
          onClose={() => setDialogName(null)}
        >
          <div className="gs-modal-body gs-remote-help">
            <div className="gs-remote-error-card">
              <XCircle size={19} />
              <div>
                <strong>Remote unavailable</strong>
                <small>{repo.remotes[0]?.fetchUrl}</small>
              </div>
            </div>
            <ol className="gs-recovery-steps">
              <li>
                <span>1</span>
                <div>
                  <strong>Make sure the repository exists</strong>
                  <p>Create an empty GitHub repository with this project name. Do not add a README or license.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Check the owner and URL</strong>
                  <p>If the repository belongs to another account or organization, update the remote.</p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Sign in with an account that has access</strong>
                  <p>Git Credential Manager stores the login securely in Windows.</p>
                </div>
              </li>
            </ol>
            <div className="gs-remote-help-actions">
              <button
                className="gs-button secondary"
                onClick={() => void gitApi.openCreateRemote(repo.root).catch((e) => notify('error', errorMessage(e)))}
              >
                <ExternalLink size={15} /> Create on GitHub
              </button>
              <button className="gs-button secondary" onClick={() => void openSettings()}>
                <Settings2 size={15} /> Edit remote or sign in
              </button>
            </div>
          </div>
          <div className="gs-modal-footer">
            <button className="gs-button secondary" onClick={() => setDialogName(null)}>
              Cancel
            </button>
            <button
              className="gs-button primary"
              disabled={busy}
              onClick={() => void perform(() => gitApi.push(repo.root)).then((ok) => ok && setDialogName(null))}
            >
              {busy ? <Spinner /> : <ArrowUpFromLine size={16} />} Try push again
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AuthCard({
  auth,
  disabled,
  onSignIn,
}: {
  auth: AuthInfo | null | undefined;
  disabled: boolean;
  onSignIn: () => void;
}) {
  const ready = !!auth?.credentialManagerInstalled;
  const checking = auth === undefined;
  return (
    <div className={`gs-auth-card ${ready ? 'ready' : ''}`}>
      <span>{checking ? <Spinner size={18} /> : ready ? <ShieldCheck size={18} /> : <KeyRound size={18} />}</span>
      <div>
        <strong>{checking ? 'Checking sign-in…' : ready ? 'Secure sign-in is ready' : 'Git authentication'}</strong>
        <small>
          {checking
            ? 'Looking for Git Credential Manager.'
            : ready
            ? `Credentials stay in Windows Credential Manager${auth?.credentialManagerVersion ? ` · GCM ${auth.credentialManagerVersion}` : ''}.`
            : 'A browser or Git prompt will handle credentials.'}
        </small>
      </div>
      <button disabled={disabled} onClick={onSignIn}>
        Sign in
      </button>
    </div>
  );
}
