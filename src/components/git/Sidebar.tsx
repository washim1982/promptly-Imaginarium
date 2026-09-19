// Git Pilot's recent-repository sidebar and welcome screen.

import { useState } from 'react';
import {
  ArrowUpFromLine,
  Cloud,
  ExternalLink,
  FilePlus2,
  FolderGit2,
  FolderOpen,
  GitFork,
  Plus,
  Search,
  Settings2,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import type { RecentRepo, RepoState } from '../../lib/git/types';
import { initials, relativeDate } from '../../lib/git/utils';

interface SidebarProps {
  recent: RecentRepo[];
  activePath?: string;
  identity?: RepoState['identity'];
  busy: boolean;
  onOpen: () => void;
  onClone: () => void;
  onInit: () => void;
  onSelect: (path: string) => void;
  onForget: (path: string) => void;
  onSettings: () => void;
}

export function Sidebar({
  recent,
  activePath,
  identity,
  busy,
  onOpen,
  onClone,
  onInit,
  onSelect,
  onForget,
  onSettings,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const filtered = recent.filter((repo) => repo.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <aside className="gs-sidebar">
      <div className="gs-brand">
        <div className="gs-brand-mark">
          <GitFork size={18} />
        </div>
        <div>
          <strong>Git Studio</strong>
          <span>Desktop workspace</span>
        </div>
      </div>

      <button className="gs-open-button" onClick={onOpen} disabled={busy}>
        <FolderOpen size={17} />
        Open repository
        <span className="gs-key-hint">Ctrl O</span>
      </button>

      <div className="gs-sidebar-actions">
        <button onClick={onClone} disabled={busy}>
          <Cloud size={15} /> Clone
        </button>
        <button onClick={onInit} disabled={busy}>
          <FilePlus2 size={15} /> Create
        </button>
      </div>

      <div className="gs-sidebar-section-heading">
        <span>Recent repositories</span>
        <span className="gs-count-bubble">{recent.length}</span>
      </div>

      {recent.length > 5 && (
        <label className="gs-repo-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a repository" />
        </label>
      )}

      <nav className="gs-repo-list" aria-label="Recent repositories">
        {filtered.map((repo, index) => {
          const active = repo.path.toLowerCase() === activePath?.toLowerCase();
          return (
            <div className={`gs-repo-item ${active ? 'active' : ''}`} key={repo.path}>
              <button
                className="gs-repo-item-main"
                onClick={() => onSelect(repo.path)}
                disabled={busy}
                title={repo.path}
              >
                <span className={`gs-repo-avatar palette-${index % 5}`}>{initials(repo.name)}</span>
                <span className="gs-repo-item-copy">
                  <strong>{repo.name}</strong>
                  <small>{relativeDate(repo.lastOpened)}</small>
                </span>
              </button>
              {active ? (
                <span className="gs-active-dot" title="Open" />
              ) : (
                // A sibling of the row button, not nested in it: a button
                // inside a button is invalid HTML and swallows keyboard focus.
                <button
                  className="gs-forget-repo"
                  title="Remove from recent repositories"
                  aria-label={`Remove ${repo.name} from recent repositories`}
                  onClick={() => onForget(repo.path)}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}
        {!filtered.length && <div className="gs-sidebar-empty">No repositories found</div>}
      </nav>

      <button className="gs-profile-card" onClick={onSettings} disabled={busy}>
        <span className="gs-profile-avatar">
          <UserRound size={16} />
        </span>
        <span>
          <strong>{identity?.name || 'Set up Git identity'}</strong>
          <small>{identity?.email || 'Name, email & sign in'}</small>
        </span>
        <Settings2 size={15} />
      </button>
    </aside>
  );
}

interface WelcomeProps {
  recent: RecentRepo[];
  gitVersion: string;
  onOpen: () => void;
  onClone: () => void;
  onInit: () => void;
  onSelect: (path: string) => void;
}

export function Welcome({ recent, gitVersion, onOpen, onClone, onInit, onSelect }: WelcomeProps) {
  return (
    <main className="gs-welcome-shell">
      <div className="gs-welcome-topbar">
        <div className={`gs-status-chip ${gitVersion ? '' : 'missing'}`}>
          <span /> {gitVersion ? 'Git is ready' : 'Git not found'}
        </div>
        <span>{gitVersion || 'Install Git for Windows to use this tab'}</span>
      </div>
      <div className="gs-welcome-content">
        <div className="gs-eyebrow">
          <Sparkles size={14} /> YOUR FRIENDLY GIT WORKSPACE
        </div>
        <h1>
          Ship your work
          <br />
          <em>without the command line.</em>
        </h1>
        <p className="gs-welcome-lead">
          Open any project, review every change, and sync it safely. Git Studio keeps the routine clear while Git keeps
          the power.
        </p>
        <div className="gs-welcome-actions">
          <button className="gs-button primary large" onClick={onOpen}>
            <FolderOpen size={18} /> Open a repository
          </button>
          <button className="gs-button secondary large" onClick={onClone}>
            <Cloud size={18} /> Clone from remote
          </button>
        </div>

        <div className="gs-quick-grid">
          <button className="gs-quick-card" onClick={onOpen}>
            <span className="gs-quick-icon teal">
              <FolderGit2 size={21} />
            </span>
            <span>
              <strong>Existing project</strong>
              <small>Choose a folder already using Git</small>
            </span>
            <ExternalLink size={16} />
          </button>
          <button className="gs-quick-card" onClick={onInit}>
            <span className="gs-quick-icon neon">
              <FilePlus2 size={21} />
            </span>
            <span>
              <strong>Start a repository</strong>
              <small>Add Git to a project folder</small>
            </span>
            <Plus size={17} />
          </button>
        </div>

        {recent.length > 0 && (
          <div className="gs-welcome-recents">
            <span>Pick up where you left off</span>
            <div>
              {recent.slice(0, 3).map((repo, index) => (
                <button key={repo.path} onClick={() => onSelect(repo.path)} title={repo.path}>
                  <span className={`gs-repo-avatar palette-${index}`}>{initials(repo.name)}</span>
                  <span>
                    <strong>{repo.name}</strong>
                    <small>{relativeDate(repo.lastOpened)}</small>
                  </span>
                  <ArrowUpFromLine size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
