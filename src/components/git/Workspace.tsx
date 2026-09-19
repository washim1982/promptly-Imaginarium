// The open-repository workspace: file explorer, overview cards, and the
// Changes / History / Branches tabs. Port of Git Pilot's RepoWorkspace and its
// child views.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cloud,
  Code2,
  Copy,
  FileCode2,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  KeyRound,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  TerminalSquare,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { DETACHED_HEAD, type RepoState } from '../../lib/git/types';
import {
  buildFileTree,
  relativeDate,
  statusLabel,
  statusLetter,
  syncHint,
  type FileTreeNode,
} from '../../lib/git/utils';
import { Spinner } from './Modal';

export type Tab = 'changes' | 'history' | 'branches';

// ---- Changes ------------------------------------------------------------------------

interface ChangesViewProps {
  repo: RepoState;
  selected: Set<string>;
  commitMessage: string;
  busy: boolean;
  onSelected: (selection: Set<string>) => void;
  onCommitMessage: (message: string) => void;
  onStage: (files: string[]) => void;
  onUnstage: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
  onCommit: () => void;
}

function ChangesView({
  repo,
  selected,
  commitMessage,
  busy,
  onSelected,
  onCommitMessage,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
}: ChangesViewProps) {
  const stagedCount = repo.changes.filter((change) => change.staged).length;
  const allSelected = repo.changes.length > 0 && selected.size === repo.changes.length;
  const selectedChanges = repo.changes.filter((change) => selected.has(change.path));
  const canStage = selectedChanges.some((change) => change.unstaged);
  const canUnstage = selectedChanges.some((change) => change.staged);

  const toggleAll = () => onSelected(allSelected ? new Set() : new Set(repo.changes.map((change) => change.path)));
  const toggle = (file: string) => {
    const next = new Set(selected);
    if (next.has(file)) next.delete(file);
    else next.add(file);
    onSelected(next);
  };

  return (
    <div className="gs-changes-layout">
      <section className="gs-panel gs-changes-panel">
        <div className="gs-panel-heading">
          <div>
            <h2>Working changes</h2>
            <p>{repo.changes.length ? 'Choose what belongs in your next commit.' : 'Everything is clean and up to date.'}</p>
          </div>
          {repo.changes.length > 0 && (
            <div className="gs-change-actions">
              <button className="gs-button text" disabled={!selected.size || busy} onClick={() => onDiscard([...selected])}>
                <Trash2 size={14} /> Discard
              </button>
              <button
                className="gs-button secondary compact"
                disabled={!canUnstage || busy}
                onClick={() => onUnstage(selectedChanges.filter((c) => c.staged).map((c) => c.path))}
              >
                <Minus size={14} /> Unstage
              </button>
              <button
                className="gs-button primary compact"
                disabled={!canStage || busy}
                onClick={() => onStage(selectedChanges.filter((c) => c.unstaged).map((c) => c.path))}
              >
                <Plus size={14} /> Stage
              </button>
            </div>
          )}
        </div>

        {repo.changes.length > 0 ? (
          <div className="gs-file-list">
            <label className="gs-file-row gs-file-row-header">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all changes" />
              <span>File</span>
              <span>Status</span>
              <span>Area</span>
            </label>
            {repo.changes.map((change) => (
              <label className="gs-file-row" key={change.path}>
                <input type="checkbox" checked={selected.has(change.path)} onChange={() => toggle(change.path)} />
                <span className="gs-file-name">
                  <span className={`gs-file-icon ${change.status}`}>
                    <FileCode2 size={15} />
                  </span>
                  <span title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}>
                    <strong>{change.path.split('/').pop()}</strong>
                    <small>{change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}</small>
                  </span>
                </span>
                <span>
                  <span className={`gs-status-pill ${change.status}`}>{statusLabel(change)}</span>
                </span>
                <span className="gs-area-tags">
                  {change.staged && (
                    <span className="gs-area staged">
                      <Check size={11} /> staged
                    </span>
                  )}
                  {change.unstaged && <span className="gs-area working">working</span>}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="gs-clean-state">
            <span>
              <CheckCircle2 size={28} />
            </span>
            <h3>Working tree is clean</h3>
            <p>There are no local changes waiting to be committed.</p>
          </div>
        )}
      </section>

      <aside className="gs-commit-panel gs-panel">
        <div className="gs-commit-heading">
          <span className="gs-commit-icon">
            <GitCommitHorizontal size={20} />
          </span>
          <div>
            <h2>Create a commit</h2>
            <p>
              {stagedCount} staged file{stagedCount === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <label className="gs-field-label" htmlFor="gs-commit-message">
          Summary
        </label>
        <textarea
          id="gs-commit-message"
          value={commitMessage}
          onChange={(event) => onCommitMessage(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl+Enter commits, as in most Git clients.
            if (event.key === 'Enter' && event.ctrlKey && stagedCount && commitMessage.trim() && !busy) {
              event.preventDefault();
              onCommit();
            }
          }}
          placeholder="Describe what changed…"
          rows={5}
          maxLength={500}
        />
        <div className="gs-character-count">{commitMessage.length}/500</div>
        <button
          className="gs-button primary gs-commit-button"
          disabled={!stagedCount || !commitMessage.trim() || busy}
          onClick={onCommit}
        >
          {busy ? <Spinner /> : <GitCommitHorizontal size={16} />}
          Commit {stagedCount ? `${stagedCount} file${stagedCount === 1 ? '' : 's'}` : ''}
        </button>
        {!stagedCount && (
          <p className="gs-commit-help">
            <CircleDot size={13} /> Stage at least one file to create a commit.
          </p>
        )}
        <div className="gs-commit-identity">
          <UserRound size={15} />
          <span>
            <strong>{repo.identity.name || 'Git identity not configured'}</strong>
            <small>{repo.identity.email || 'Open Account & remote to add your name and email'}</small>
          </span>
        </div>
      </aside>
    </div>
  );
}

// ---- History ------------------------------------------------------------------------

function HistoryView({ repo, onCopied }: { repo: RepoState; onCopied: (hash: string) => void }) {
  return (
    <section className="gs-panel gs-history-panel">
      <div className="gs-panel-heading">
        <div>
          <h2>Commit history</h2>
          <p>
            The latest {repo.commits.length} commits on {repo.branch}.
          </p>
        </div>
        <span className="gs-history-count">
          <History size={15} /> {repo.commits.length} shown
        </span>
      </div>
      {repo.commits.length ? (
        <div className="gs-timeline">
          {repo.commits.map((commit, index) => (
            <article className="gs-commit-row" key={commit.hash}>
              <div className="gs-timeline-rail">
                <span className={index === 0 ? 'latest' : ''} />
                {index < repo.commits.length - 1 && <i />}
              </div>
              <div className="gs-commit-copy">
                <strong>{commit.subject}</strong>
                <p>
                  <span>{commit.author}</span> committed {relativeDate(commit.date)}
                </p>
              </div>
              <button
                className="gs-hash-button"
                title="Copy commit hash"
                onClick={() =>
                  void navigator.clipboard.writeText(commit.hash).then(
                    () => onCopied(commit.shortHash),
                    () => {},
                  )
                }
              >
                <Code2 size={13} /> {commit.shortHash} <Copy size={11} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="gs-clean-state">
          <span>
            <GitCommitHorizontal size={28} />
          </span>
          <h3>No commits yet</h3>
          <p>Your first commit will appear here.</p>
        </div>
      )}
    </section>
  );
}

// ---- Branches -----------------------------------------------------------------------

interface BranchesViewProps {
  repo: RepoState;
  busy: boolean;
  onSwitch: (branch: string) => void;
  onMerge: (branch: string) => void;
  onNew: () => void;
  onSettings: () => void;
}

function BranchesView({ repo, busy, onSwitch, onMerge, onNew, onSettings }: BranchesViewProps) {
  return (
    <div className="gs-branches-layout">
      <section className="gs-panel gs-branches-panel">
        <div className="gs-panel-heading">
          <div>
            <h2>Local branches</h2>
            <p>The current branch is the destination when you merge.</p>
          </div>
          <button className="gs-button primary compact" onClick={onNew} disabled={busy}>
            <Plus size={15} /> New branch
          </button>
        </div>
        <div className="gs-branch-list">
          {repo.branches.map((branch) => (
            <div className={`gs-branch-row ${branch.current ? 'current' : ''}`} key={branch.name}>
              <span className="gs-branch-symbol">
                <GitBranch size={16} />
              </span>
              <span>
                <strong>{branch.name}</strong>
                <small>
                  {branch.upstream || 'Local only'} ·{' '}
                  {branch.lastCommitDate ? relativeDate(branch.lastCommitDate) : 'no commits yet'}
                </small>
              </span>
              {branch.current ? (
                <span className="gs-current-label">
                  <Check size={12} /> Current
                </span>
              ) : (
                <span className="gs-branch-actions">
                  <button className="gs-branch-action" onClick={() => onSwitch(branch.name)} disabled={busy}>
                    Switch
                  </button>
                  <button className="gs-branch-action merge" onClick={() => onMerge(branch.name)} disabled={busy}>
                    <GitMerge size={12} /> Merge
                  </button>
                </span>
              )}
            </div>
          ))}
          {!repo.branches.length && <div className="gs-tree-empty">No local branches yet.</div>}
        </div>
      </section>
      <aside className="gs-panel gs-remote-panel">
        <div className="gs-remote-art">
          <Cloud size={24} />
        </div>
        <h2>Remote connection</h2>
        {repo.remotes.length ? (
          repo.remotes.map((remote) => (
            <div className="gs-remote-entry" key={remote.name}>
              <span>
                <Cloud size={14} />
              </span>
              <div>
                <strong>{remote.name}</strong>
                <small title={remote.fetchUrl}>{remote.fetchUrl}</small>
              </div>
            </div>
          ))
        ) : (
          <p>This repository is local only. Add a remote when you’re ready to share it.</p>
        )}
        <button className="gs-button secondary" onClick={onSettings}>
          <Settings2 size={15} /> Manage remote
        </button>
      </aside>
    </div>
  );
}

// ---- File explorer -------------------------------------------------------------------

function RepoFileExplorer({ repo }: { repo: RepoState }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      normalizedQuery ? repo.files.filter((file) => file.path.toLocaleLowerCase().includes(normalizedQuery)) : repo.files,
    [normalizedQuery, repo.files],
  );
  const tree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const uploadedCount = useMemo(() => repo.files.filter((file) => file.uploaded).length, [repo.files]);

  // A newly opened repository starts with its top-level folders expanded.
  useEffect(() => {
    const topLevelFolders = buildFileTree(repo.files)
      .filter((node) => node.kind === 'folder')
      .map((node) => node.path);
    setExpanded(new Set(topLevelFolders));
    setQuery('');
  }, [repo.root]); // eslint-disable-line react-hooks/exhaustive-deps -- only on a new repository

  const toggleFolder = (folderPath: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  const renderNodes = (nodes: FileTreeNode[], depth = 0): ReactNode =>
    nodes.map((node) => {
      if (node.kind === 'folder') {
        const open = Boolean(normalizedQuery) || expanded.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              className="gs-tree-row folder"
              style={{ paddingLeft: `${10 + depth * 14}px` }}
              onClick={() => toggleFolder(node.path)}
              aria-expanded={open}
              title={node.path}
            >
              <ChevronRight className={open ? 'gs-tree-chevron open' : 'gs-tree-chevron'} size={12} />
              {open ? <FolderOpen size={14} /> : <Folder size={14} />}
              <span>{node.name}</span>
            </button>
            {open && renderNodes(node.children, depth + 1)}
          </div>
        );
      }

      return (
        <div
          className="gs-tree-row file"
          style={{ paddingLeft: `${25 + depth * 14}px` }}
          title={node.uploaded ? `${node.path} — on ${repo.upstream}` : `${node.path} — local only or not pushed yet`}
          key={node.path}
        >
          <FileCode2 size={13} />
          <span>{node.name}</span>
          {node.status && <small className={`gs-tree-status ${node.status}`}>{statusLetter(node.status)}</small>}
          {node.uploaded && <i className="gs-upload-dot" aria-label="Uploaded to remote" />}
        </div>
      );
    });

  return (
    <aside className="gs-explorer" aria-label="Local repository files">
      <div className="gs-explorer-heading">
        <span className="gs-explorer-icon">
          <FolderGit2 size={16} />
        </span>
        <div>
          <strong>Local files</strong>
          <small>
            {repo.files.length}
            {repo.filesTruncated ? '+' : ''} in repository
          </small>
        </div>
      </div>
      <label className="gs-file-search">
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files"
          aria-label="Search repository files"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear file search">
            <X size={11} />
          </button>
        )}
      </label>
      <div className="gs-tree-root">
        <FolderOpen size={15} />
        <strong title={repo.root}>{repo.name}</strong>
        <span>{repo.files.length}</span>
      </div>
      <div className="gs-file-tree" role="tree">
        {tree.length ? (
          renderNodes(tree)
        ) : (
          <div className="gs-tree-empty">{query ? 'No matching files.' : 'This repository has no files yet.'}</div>
        )}
        {repo.filesTruncated && (
          <div className="gs-tree-empty">Showing the first {repo.files.length.toLocaleString()} files.</div>
        )}
      </div>
      <div className="gs-explorer-legend">
        {repo.upstream ? (
          <>
            <span className="gs-upload-dot" />
            <span>
              <strong>{uploadedCount} uploaded</strong>
              <small>Dot = on {repo.upstream}</small>
            </span>
          </>
        ) : (
          <>
            <Cloud size={13} />
            <span>
              <strong>No upstream branch</strong>
              <small>Push once to show uploaded files</small>
            </span>
          </>
        )}
      </div>
    </aside>
  );
}

// ---- Workspace ----------------------------------------------------------------------

interface RepoWorkspaceProps {
  repo: RepoState;
  tab: Tab;
  busy: boolean;
  selected: Set<string>;
  commitMessage: string;
  onTab: (tab: Tab) => void;
  onSelected: (selected: Set<string>) => void;
  onCommitMessage: (message: string) => void;
  onStage: (files: string[]) => void;
  onUnstage: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
  onCommit: () => void;
  onSync: (operation: 'fetch' | 'pull' | 'push') => void;
  onRefresh: () => void;
  onSwitchBranch: (branch: string) => void;
  onMergeBranch: (branch: string) => void;
  onNewBranch: () => void;
  onSettings: () => void;
  onOpenExplorer: () => void;
  onOpenTerminal: () => void;
  onCopied: (hash: string) => void;
}

export function RepoWorkspace({
  repo,
  tab,
  busy,
  selected,
  commitMessage,
  onTab,
  onSelected,
  onCommitMessage,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onSync,
  onRefresh,
  onSwitchBranch,
  onMergeBranch,
  onNewBranch,
  onSettings,
  onOpenExplorer,
  onOpenTerminal,
  onCopied,
}: RepoWorkspaceProps) {
  const staged = repo.changes.filter((change) => change.staged).length;
  const hasRemote = repo.remotes.length > 0;
  const noRemote = !hasRemote ? 'Add a remote first' : undefined;
  const detached = repo.branch === DETACHED_HEAD;

  return (
    <main className="gs-workspace">
      <header className="gs-workspace-topbar">
        <div className="gs-breadcrumb">
          <FolderGit2 size={16} />
          <strong>{repo.name}</strong>
          <span>/</span>
          <span>{repo.branch}</span>
        </div>
        <div className="gs-topbar-actions">
          <button className="gs-icon-button" onClick={onOpenTerminal} title="Open terminal" aria-label="Open terminal">
            <TerminalSquare size={16} />
          </button>
          <button
            className="gs-icon-button"
            onClick={onOpenExplorer}
            title="Open in File Explorer"
            aria-label="Open in File Explorer"
          >
            <FolderOpen size={16} />
          </button>
          <button className="gs-button sign-in" onClick={onSettings}>
            <KeyRound size={14} /> Account & remote
          </button>
        </div>
      </header>

      <div className="gs-workspace-body">
        <RepoFileExplorer repo={repo} />
        <div className="gs-workspace-scroll">
          <section className="gs-repo-hero">
            <div className="gs-repo-title-row">
              <div>
                <div className="gs-eyebrow">
                  <span className="gs-live-dot" /> ACTIVE REPOSITORY
                </div>
                <h1>{repo.name}</h1>
                <p title={repo.root}>{repo.root}</p>
              </div>
              <div className="gs-sync-buttons">
                <button className="gs-button secondary" onClick={() => onSync('fetch')} disabled={!hasRemote || busy} title={noRemote}>
                  {busy ? <Spinner size={15} /> : <RefreshCw size={15} />} Fetch
                </button>
                <button className="gs-button secondary" onClick={() => onSync('pull')} disabled={!hasRemote || busy} title={noRemote}>
                  <ArrowDownToLine size={15} /> Pull {repo.behind > 0 && <b>{repo.behind}</b>}
                </button>
                <button className="gs-button primary" onClick={() => onSync('push')} disabled={!hasRemote || busy} title={noRemote}>
                  <ArrowUpFromLine size={15} /> Push {repo.ahead > 0 && <b>{repo.ahead}</b>}
                </button>
              </div>
            </div>

            <div className="gs-overview-grid">
              <div className="gs-overview-card gs-branch-card">
                <span className="gs-overview-icon">
                  <GitBranch size={19} />
                </span>
                <div>
                  <small>CURRENT BRANCH</small>
                  <strong>{repo.branch}</strong>
                  <span>{repo.upstream || 'No upstream yet'}</span>
                </div>
                <label className="gs-branch-select">
                  <select
                    value={detached ? '' : repo.branch}
                    onChange={(event) => onSwitchBranch(event.target.value)}
                    disabled={busy}
                    aria-label="Switch branch"
                  >
                    {detached && (
                      <option value="" disabled>
                        {DETACHED_HEAD}
                      </option>
                    )}
                    {repo.branches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </label>
              </div>
              <div className="gs-overview-card">
                <span className="gs-overview-icon amber">
                  <FileCode2 size={19} />
                </span>
                <div>
                  <small>CHANGES</small>
                  <strong>{repo.changes.length}</strong>
                  <span>{repo.changes.length ? 'files need attention' : 'working tree clean'}</span>
                </div>
              </div>
              <div className="gs-overview-card">
                <span className="gs-overview-icon violet">
                  <CheckCircle2 size={19} />
                </span>
                <div>
                  <small>STAGED</small>
                  <strong>{staged}</strong>
                  <span>{staged ? 'ready to commit' : 'nothing staged yet'}</span>
                </div>
              </div>
              <div className="gs-overview-card">
                <span className="gs-overview-icon teal">
                  <ArrowLeftRight size={19} />
                </span>
                <div>
                  <small>REMOTE SYNC</small>
                  <strong>
                    {repo.ahead} ↑ {repo.behind} ↓
                  </strong>
                  <span>{syncHint(repo)}</span>
                </div>
              </div>
            </div>
          </section>

          <nav className="gs-tabs" aria-label="Repository sections">
            <button className={tab === 'changes' ? 'active' : ''} onClick={() => onTab('changes')}>
              <FileCode2 size={16} /> Changes <span>{repo.changes.length}</span>
            </button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => onTab('history')}>
              <History size={16} /> History
            </button>
            <button className={tab === 'branches' ? 'active' : ''} onClick={() => onTab('branches')}>
              <GitBranch size={16} /> Branches <span>{repo.branches.length}</span>
            </button>
            <button className="gs-refresh-tab" onClick={onRefresh} disabled={busy}>
              <RefreshCw className={busy ? 'gs-spin' : ''} size={15} /> Refresh
            </button>
          </nav>

          {tab === 'changes' && (
            <ChangesView
              repo={repo}
              selected={selected}
              commitMessage={commitMessage}
              busy={busy}
              onSelected={onSelected}
              onCommitMessage={onCommitMessage}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
              onCommit={onCommit}
            />
          )}
          {tab === 'history' && <HistoryView repo={repo} onCopied={onCopied} />}
          {tab === 'branches' && (
            <BranchesView
              repo={repo}
              busy={busy}
              onSwitch={onSwitchBranch}
              onMerge={onMergeBranch}
              onNew={onNewBranch}
              onSettings={onSettings}
            />
          )}
        </div>
      </div>
    </main>
  );
}
