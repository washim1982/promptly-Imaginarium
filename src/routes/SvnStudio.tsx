// SVN Studio, as a tab of Imaginarium. Port of SVN Studio's web/client/src/App.tsx:
// same three-panel IDE (Explorer · editor · Source Control / History), command
// palette and status bar. The activity bar is gone: the toolbar toggles the
// panels and History opens from the Source Control header. SVN calls go to the Electron main process
// instead of an Express server, and AI review runs on the in-app LiteRT-LM engine
// with gemma-4-E4B-it-web instead of an external OpenAI-compatible endpoint.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLlm } from '../state/LlmContext';
import { resolveAccent } from '../lib/themes';
import { svnApi } from '../lib/svn/api';
import type { AiScope, SvnLogEntry, SvnTreeNode } from '../lib/svn/types';
import { baseName, countStatuses, displayLanguageFromPath, flattenTree } from '../lib/svn/utils';
import {
  buildReviewPrompt,
  contextBudget,
  findReviewModel,
  REVIEW_MODEL_LABEL,
  REVIEW_SYSTEM_PROMPT,
  stripThinking,
} from '../lib/svn/review';
import { usePrompt } from '../components/PromptDialog';
import { CommandPalette, type PaletteCommand } from '../components/svn/CommandPalette';
import { StatusBar } from '../components/svn/StatusBar';
import { FileTree, type FileTreeActions } from '../components/svn/FileTree';
import { FileViewer } from '../components/svn/FileViewer';
import { CommitPanel } from '../components/svn/CommitPanel';
import { HistoryPanel } from '../components/svn/HistoryPanel';
import { SvnSettings } from '../components/svn/SvnSettings';
import { ResizeHandle } from '../components/svn/ResizeHandle';
import { AiReviewModal, type AiReviewState } from '../components/svn/AiReviewModal';
import type { ReviewModelState } from '../components/svn/AiAssistBox';
import {
  IconChevronLeft,
  IconChevronRight,
  IconPanelLeft,
  IconPanelRight,
  IconSearch,
  IconSettings,
} from '../components/svn/icons';
import '../components/svn/svn-studio.css';

const LEFT_DEFAULT = 280;
const RIGHT_DEFAULT = 360;
const LEFT_MIN = 190;
const RIGHT_MIN = 280;
const PANEL_MAX = 720;
// A usable minimum editor width + gaps and side padding.
const RESERVED_FOR_EDITOR = 360 + 72;

function clampPanel(value: number, min: number, otherPanelWidth: number): number {
  const max = Math.min(PANEL_MAX, window.innerWidth - otherPanelWidth - RESERVED_FOR_EDITOR);
  return Math.round(Math.max(min, Math.min(value, Math.max(min, max))));
}

// Panel widths are a per-viewer layout preference, so localStorage fits. It can
// throw (blocked storage) — fall back to defaults silently.
function usePanelWidth(key: string, fallback: number) {
  const [width, setWidthState] = useState(() => {
    try {
      const n = Number(localStorage.getItem(key));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    } catch {
      return fallback;
    }
  });
  const setWidth = useCallback(
    (next: number) => {
      setWidthState(next);
      try {
        localStorage.setItem(key, String(Math.round(next)));
      } catch {
        /* width still applies for this session */
      }
    },
    [key],
  );
  return [width, setWidth, () => setWidth(fallback)] as const;
}

const repoNameFrom = (wcPath: string) => wcPath.split(/[/\\]/).filter(Boolean).pop() ?? '';

export default function SvnStudio() {
  const navigate = useNavigate();
  const ask = usePrompt();
  const llm = useLlm();
  const accent = resolveAccent(llm.theme, llm.customGlow);

  const [tree, setTree] = useState<SvnTreeNode | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [diff, setDiff] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [editable, setEditable] = useState(false);
  const [busy, setBusy] = useState(false);
  // What the right-hand panel shows. History opens from the button in the
  // Source Control header (SVN Studio's activity bar was removed).
  const [activeView, setActiveView] = useState<'commit' | 'history'>('commit');
  const [historyEntries, setHistoryEntries] = useState<SvnLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyScope, setHistoryScope] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [repoName, setRepoName] = useState('');
  const [leftPanelVisible, setLeftPanelVisible] = useState(true);
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aiReview, setAiReview] = useState<AiReviewState | null>(null);
  const [leftWidth, setLeftWidth, resetLeftWidth] = usePanelWidth('svn-studio-left-width', LEFT_DEFAULT);
  const [rightWidth, setRightWidth, resetRightWidth] = usePanelWidth('svn-studio-right-width', RIGHT_DEFAULT);
  const [navHistory, setNavHistory] = useState<string[]>([]);
  const [navIndex, setNavIndex] = useState(-1);

  const dirty = editable && selectedPath !== null && draftContent !== savedContent;
  const effectiveLeft = leftPanelVisible ? leftWidth : 0;
  const effectiveRight = rightPanelVisible ? rightWidth : 0;

  // ---- AI review model ----------------------------------------------------------

  const reviewModel = findReviewModel(llm.models);
  const reviewModelState: ReviewModelState = !reviewModel
    ? 'missing'
    : llm.activeModel?.id === reviewModel.id && llm.status === 'ready'
      ? 'ready'
      : 'will-load';

  // Values read *after* an await must come from refs: the closure that started
  // the review predates the model load it triggered.
  const latest = useRef({ llm, reviewModel });
  latest.current = { llm, reviewModel };
  const stoppedRef = useRef(false);

  // ---- data ------------------------------------------------------------------------

  const refreshTree = useCallback(async () => {
    try {
      setTree(await svnApi.getTree());
      setError(null);
    } catch (err) {
      setTree(null);
      setError((err as Error).message);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await svnApi.getSettings();
      const ok = Boolean(s.workingCopyPath);
      setConfigured(ok);
      setRepoName(repoNameFrom(s.workingCopyPath));
      if (ok) await refreshTree();
    } catch (err) {
      setConfigured(false);
      setError((err as Error).message);
    }
  }, [refreshTree]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // First visit with nothing configured: open Settings straight away.
  useEffect(() => {
    if (configured === false) setSettingsOpen(true);
  }, [configured]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  async function loadFile(path: string) {
    setLoadingFile(true);
    setDiff(null);
    try {
      const [content, diffText] = await Promise.all([
        svnApi.getFile(path),
        svnApi.getDiff(path).catch(() => ''),
      ]);
      setDraftContent(content);
      setSavedContent(content);
      setDiff(diffText || null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingFile(false);
    }
  }

  /** SVN Studio switched files without asking, discarding unsaved edits. */
  function confirmDiscard(): boolean {
    return !dirty || window.confirm(`Discard unsaved changes to ${baseName(selectedPath!)}?`);
  }

  function navigateToFile(path: string) {
    if (path === selectedPath || !confirmDiscard()) return;
    setSelectedPath(path);
    setNavHistory((prev) => {
      const next = [...prev.slice(0, navIndex + 1), path];
      setNavIndex(next.length - 1);
      return next;
    });
    void loadFile(path);
  }

  function goTo(index: number) {
    if (index < 0 || index >= navHistory.length || !confirmDiscard()) return;
    setNavIndex(index);
    setSelectedPath(navHistory[index]);
    void loadFile(navHistory[index]);
  }

  async function withBusy(fn: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshTree();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveFile() {
    if (!selectedPath || !dirty) return;
    const path = selectedPath;
    const content = draftContent;
    const ok = await withBusy(async () => {
      await svnApi.saveFile(path, content);
    });
    if (ok) {
      setSavedContent(content);
      setDiff((await svnApi.getDiff(path).catch(() => '')) || null);
    }
  }

  async function loadHistory(path?: string) {
    setActiveView('history');
    setRightPanelVisible(true);
    setHistoryLoading(true);
    setHistoryScope(path ?? null);
    try {
      setHistoryEntries(await svnApi.getHistory(path));
    } catch (err) {
      setHistoryEntries([]);
      setError((err as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  }

  const noSlash = (v: string) => (/[\\/:*?"<>|]/.test(v) ? 'Names cannot contain \\ / : * ? " < > |' : null);

  const treeActions: FileTreeActions = {
    onSelectFile: navigateToFile,
    onUpload: (targetFolder, kind) =>
      void withBusy(async () => {
        const { added } = await svnApi.uploadPick(targetFolder, kind);
        if (added.length) setNotice(`Added ${added.length} item${added.length === 1 ? '' : 's'}`);
      }),
    onDropFiles: (targetFolder, files) =>
      void withBusy(async () => {
        const { added } = await svnApi.importFiles(targetFolder, files);
        if (added.length) setNotice(`Added ${added.length} item${added.length === 1 ? '' : 's'}`);
      }),
    onCreateFile: async (targetFolder) => {
      const name = await ask({
        title: 'New file',
        label: targetFolder ? `In ${targetFolder}/` : 'In the working-copy root',
        placeholder: 'name.ext',
        confirmLabel: 'Create',
        validate: noSlash,
      });
      if (!name) return;
      const fullPath = targetFolder ? `${targetFolder}/${name}` : name;
      if (await withBusy(() => svnApi.createFile(fullPath))) navigateToFile(fullPath);
    },
    onCreateFolder: async (targetFolder) => {
      const name = await ask({
        title: 'New folder',
        label: targetFolder ? `In ${targetFolder}/` : 'In the working-copy root',
        confirmLabel: 'Create',
        validate: noSlash,
      });
      if (!name) return;
      await withBusy(() => svnApi.createFolder(targetFolder ? `${targetFolder}/${name}` : name));
    },
    onDelete: (path) => {
      if (!window.confirm(`Delete "${path}"? It is removed from disk now and from the repository on commit.`)) return;
      void withBusy(async () => {
        await svnApi.deletePath(path);
        if (selectedPath === path || selectedPath?.startsWith(`${path}/`)) setSelectedPath(null);
      });
    },
    onRename: async (path) => {
      const parts = path.split('/');
      const currentName = parts.pop() ?? path;
      const newName = await ask({
        title: 'Rename',
        defaultValue: currentName,
        confirmLabel: 'Rename',
        validate: (v) => noSlash(v) ?? (v === currentName ? 'Enter a different name' : null),
      });
      if (!newName) return;
      const toPath = [...parts, newName].join('/');
      const ok = await withBusy(() => svnApi.renamePath(path, toPath));
      if (ok && selectedPath === path) {
        setSelectedPath(toPath);
        void loadFile(toPath);
      }
    },
    onCommitSelected: () => {
      setActiveView('commit');
      setRightPanelVisible(true);
    },
    onRevert: (path) => {
      if (!window.confirm(`Revert "${path}"? Uncommitted changes will be permanently lost.`)) return;
      void withBusy(async () => {
        await svnApi.revert([path]);
        if (selectedPath === path) void loadFile(path);
      });
    },
    onViewHistory: (path) => void loadHistory(path),
  };

  // ---- AI review ------------------------------------------------------------------

  async function runAiReview(scope: AiScope, question: string, scopeLabel: string) {
    const target = latest.current.reviewModel;
    if (!target) {
      setAiReview({
        status: 'error',
        missingModel: true,
        error: `AI review runs on ${REVIEW_MODEL_LABEL}, which isn't in your model library yet.\n\nOpen the Chat tab, choose "Add another model…", and select gemma-4-E4B-it-web.litertlm.`,
      });
      return;
    }
    if (latest.current.llm.isGenerating) {
      setAiReview({
        status: 'error',
        error: 'The model is busy with another task (Chat, Research or PDF Tools). Wait for it to finish, then try again.',
      });
      return;
    }

    const meta = { scopeLabel, question, model: target.label };
    stoppedRef.current = false;

    // The engine holds one model at a time. If a different one is loaded,
    // switch to E4B — which is also what Chat will use afterwards.
    const current = latest.current.llm;
    if (!(current.activeModel?.id === target.id && current.status === 'ready')) {
      setAiReview({ status: 'loading-model', ...meta });
      const ok = await current.loadModel({ type: 'library', id: target.id });
      if (!ok) {
        // Let React commit the error state set during the failed load.
        await new Promise((r) => setTimeout(r, 0));
        setAiReview({
          status: 'error',
          error: `Couldn't load ${target.label}: ${latest.current.llm.error ?? 'unknown error'}`,
        });
        return;
      }
    }

    try {
      setAiReview({ status: 'context', ...meta });
      const budget = contextBudget(latest.current.llm.settings);
      const ctx = await svnApi.aiContext(scope, budget);

      const base = { status: 'streaming' as const, ...meta, text: '', fileCount: ctx.fileCount, truncated: ctx.truncated };
      setAiReview(base);

      let raw = '';
      for await (const token of latest.current.llm.generate(buildReviewPrompt(ctx.context, question), REVIEW_SYSTEM_PROMPT)) {
        raw += token;
        const text = stripThinking(raw);
        setAiReview((prev) => (prev && prev.status === 'streaming' ? { ...prev, text } : prev));
      }
      const text = stripThinking(raw).trim();
      setAiReview({
        ...base,
        status: 'done',
        text: text || (stoppedRef.current ? '' : '_The model returned an empty response._'),
        stopped: stoppedRef.current,
      });
    } catch (err) {
      setAiReview({ status: 'error', error: (err as Error).message });
    }
  }

  function stopReview() {
    stoppedRef.current = true;
    llm.cancel();
  }

  // ---- derived -----------------------------------------------------------------------

  const { changed: changedCount, conflicted: conflictedCount } = useMemo(() => countStatuses(tree), [tree]);
  const flatFiles = useMemo(() => flattenTree(tree), [tree]);
  const folderPaths = useMemo(() => flatFiles.filter((f) => f.isDirectory).map((f) => f.path), [flatFiles]);

  const doUpdate = () =>
    void withBusy(async () => {
      const { output } = await svnApi.update();
      const rev = /revision (\d+)/i.exec(output)?.[1];
      setNotice(rev ? `Updated to revision ${rev}` : 'Working copy updated');
      if (selectedPath) void loadFile(selectedPath);
    });

  const paletteCommands: PaletteCommand[] = [
    { id: 'update', label: 'SVN: Update working copy', run: doUpdate },
    {
      id: 'commit-view',
      label: 'SVN: Show Source Control',
      run: () => {
        setActiveView('commit');
        setRightPanelVisible(true);
      },
    },
    { id: 'history-view', label: 'SVN: Show History', run: () => void loadHistory(undefined) },
    { id: 'refresh', label: 'Explorer: Refresh tree', run: () => void refreshTree() },
    { id: 'edit', label: `Editor: ${editable ? 'Disable' : 'Enable'} editing`, run: () => setEditable((v) => !v) },
    { id: 'settings', label: 'Preferences: SVN Settings', run: () => setSettingsOpen(true) },
  ];

  // ---- render ---------------------------------------------------------------------------

  return (
    <div className="svn-studio">
      {/* SVN Studio's title bar, minus what the app window already provides. */}
      <div className="svn-toolbar">
        <div className="svn-toolbar__group">
          <button className="svn-toolbar__icon" disabled={navIndex <= 0} onClick={() => goTo(navIndex - 1)} title="Back">
            <IconChevronLeft size={16} />
          </button>
          <button
            className="svn-toolbar__icon"
            disabled={navIndex >= navHistory.length - 1}
            onClick={() => goTo(navIndex + 1)}
            title="Forward"
          >
            <IconChevronRight size={16} />
          </button>
        </div>

        <button className="svn-toolbar__search" onClick={() => setPaletteOpen(true)}>
          <IconSearch size={14} />
          <span>Search files or commands</span>
          <kbd className="svn-kbd">Ctrl K</kbd>
        </button>

        <div className="svn-toolbar__group">
          {error && (
            <span className="svn-toolbar__error" title={`${error}\n\nClick to dismiss`} onClick={() => setError(null)}>
              ⚠ {error}
            </span>
          )}
          {!error && notice && <span className="svn-label" style={{ color: 'var(--svn-accent)' }}>{notice}</span>}
          <label className={`svn-toggle ${editable ? 'svn-toggle--on' : ''}`} title="Allow editing and saving files">
            <input
              type="checkbox"
              checked={editable}
              onChange={(e) => {
                if (!e.target.checked && !confirmDiscard()) return;
                if (!e.target.checked) setDraftContent(savedContent);
                setEditable(e.target.checked);
              }}
            />
            Editable
          </label>
          <button
            className={`svn-toolbar__icon ${leftPanelVisible ? 'svn-toolbar__icon--on' : ''}`}
            onClick={() => setLeftPanelVisible((v) => !v)}
            title="Toggle Explorer"
          >
            <IconPanelLeft size={16} />
          </button>
          <button
            className={`svn-toolbar__icon ${rightPanelVisible ? 'svn-toolbar__icon--on' : ''}`}
            onClick={() => setRightPanelVisible((v) => !v)}
            title="Toggle Source Control"
          >
            <IconPanelRight size={16} />
          </button>
          <button className="svn-toolbar__icon" onClick={() => setSettingsOpen(true)} title="SVN Settings">
            <IconSettings size={16} />
          </button>
        </div>
      </div>

      <div className="svn-workspace">
        {leftPanelVisible && (
          <>
            <div className="svn-panel" style={{ width: leftWidth }}>
              {configured === false ? (
                <div className="svn-muted-note">
                  No working copy linked yet.{' '}
                  <button className="svn-btn" onClick={() => setSettingsOpen(true)}>
                    Open SVN Settings
                  </button>
                </div>
              ) : (
                <FileTree
                  root={tree}
                  selectedPath={selectedPath}
                  repoName={repoName}
                  onRefresh={() => void refreshTree()}
                  {...treeActions}
                />
              )}
            </div>
            <ResizeHandle
              side="left"
              label="Resize Explorer"
              width={leftWidth}
              onResize={(w) => setLeftWidth(clampPanel(w, LEFT_MIN, effectiveRight))}
              onReset={resetLeftWidth}
            />
          </>
        )}

        <div className="svn-center">
          <FileViewer
            path={selectedPath}
            content={draftContent}
            diff={diff}
            editable={editable}
            dirty={dirty}
            loading={loadingFile}
            accent={accent}
            onContentChange={setDraftContent}
            onSave={() => void handleSaveFile()}
          />
        </div>

        {rightPanelVisible && (
          <>
            <ResizeHandle
              side="right"
              label="Resize Source Control"
              width={rightWidth}
              onResize={(w) => setRightWidth(clampPanel(w, RIGHT_MIN, effectiveLeft))}
              onReset={resetRightWidth}
            />
            <div className="svn-panel" style={{ width: rightWidth }}>
              {activeView === 'history' ? (
                <HistoryPanel
                  entries={historyEntries}
                  loading={historyLoading}
                  scopedPath={historyScope}
                  onClose={() => setActiveView('commit')}
                  onLockToggle={(path, lock) =>
                    void withBusy(async () => {
                      if (lock) await svnApi.lock(path);
                      else await svnApi.unlock(path);
                      setNotice(`${lock ? 'Locked' : 'Unlocked'} ${baseName(path)}`);
                    })
                  }
                />
              ) : (
                <CommitPanel
                  tree={tree}
                  onShowHistory={() => void loadHistory(undefined)}
                  busy={busy}
                  onCommit={(paths, message) =>
                    withBusy(async () => {
                      const { output } = await svnApi.commit(paths, message);
                      const rev = /Committed revision (\d+)/.exec(output)?.[1];
                      setNotice(rev ? `Committed revision ${rev}` : 'Committed');
                    })
                  }
                  onUpdate={doUpdate}
                  onRevert={(paths) =>
                    void withBusy(async () => {
                      await svnApi.revert(paths);
                      if (selectedPath && paths.includes(selectedPath)) void loadFile(selectedPath);
                    })
                  }
                  onOpenFile={navigateToFile}
                  onAiReview={(scope, question, label) => void runAiReview(scope, question, label)}
                  aiReviewing={
                    aiReview?.status === 'loading-model' ||
                    aiReview?.status === 'context' ||
                    aiReview?.status === 'streaming'
                  }
                  reviewModelLabel={reviewModel?.label ?? REVIEW_MODEL_LABEL}
                  reviewModelState={reviewModelState}
                  openFilePath={selectedPath}
                  folders={folderPaths}
                />
              )}
            </div>
          </>
        )}
      </div>

      <StatusBar
        configured={Boolean(configured)}
        repoLabel={repoName || 'working copy'}
        changedCount={changedCount}
        conflictedCount={conflictedCount}
        busy={busy}
        language={displayLanguageFromPath(selectedPath)}
        reviewModel={reviewModel?.label ?? REVIEW_MODEL_LABEL}
        reviewModelReady={reviewModelState === 'ready'}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        files={flatFiles}
        commands={paletteCommands}
        onSelectFile={navigateToFile}
      />

      {aiReview && (
        <AiReviewModal
          state={aiReview}
          modelProgress={aiReview.status === 'loading-model' ? llm.progress?.ratio ?? null : null}
          onClose={() => setAiReview(null)}
          onStop={stopReview}
          onOpenModels={() => {
            setAiReview(null);
            navigate('/chat');
          }}
        />
      )}

      {settingsOpen && (
        <SvnSettings
          reviewModelLabel={reviewModel?.label ?? REVIEW_MODEL_LABEL}
          reviewModelState={reviewModelState}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            setSelectedPath(null);
            setNavHistory([]);
            setNavIndex(-1);
            void loadSettings();
          }}
        />
      )}
    </div>
  );
}
