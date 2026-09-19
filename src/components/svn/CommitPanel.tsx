import { useEffect, useMemo, useState } from 'react';
import type { AiScope, SvnTreeNode } from '../../lib/svn/types';
import { collectChangedPaths, defaultCommitSelection, pruneToChanges } from '../../lib/svn/utils';
import { AiAssistBox, type ReviewModelState } from './AiAssistBox';
import { ChangesTree } from './ChangesTree';
import { IconCheck, IconDownload, IconSend, IconSparkle } from './icons';

interface CommitPanelProps {
  tree: SvnTreeNode | null;
  onCommit: (paths: string[], message: string) => Promise<boolean>;
  onUpdate: () => void;
  onRevert: (paths: string[]) => void;
  onOpenFile: (path: string) => void;
  onAiReview: (scope: AiScope, question: string, scopeLabel: string) => void;
  busy: boolean;
  aiReviewing: boolean;
  reviewModelLabel: string;
  reviewModelState: ReviewModelState;
  openFilePath: string | null;
  folders: string[];
}

export function CommitPanel({
  tree,
  onCommit,
  onUpdate,
  onRevert,
  onOpenFile,
  onAiReview,
  busy,
  aiReviewing,
  reviewModelLabel,
  reviewModelState,
  openFilePath,
  folders,
}: CommitPanelProps) {
  const [aiOpen, setAiOpen] = useState(false);
  const changesTree = useMemo(() => (tree ? pruneToChanges(tree) : null), [tree]);
  const changedPaths = useMemo(() => (changesTree ? collectChangedPaths(changesTree) : []), [changesTree]);
  const [message, setMessage] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Pre-select every tracked change so Commit does something the moment a change
  // appears (unversioned items stay unticked — see defaultCommitSelection).
  // Re-syncs only when the *set* of changed paths changes, so an in-progress
  // selection survives unrelated re-renders. "|" can't appear in a Windows path,
  // so it's a safe separator for the key.
  const changedPathsKey = changedPaths.slice().sort().join('|');
  useEffect(() => {
    setChecked(new Set(changesTree ? defaultCommitSelection(changesTree) : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedPathsKey]);

  function handleToggle(paths: string[], value: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      paths.forEach((p) => (value ? next.add(p) : next.delete(p)));
      return next;
    });
  }

  function toggleAll() {
    setChecked(checked.size === changedPaths.length ? new Set() : new Set(changedPaths));
  }

  const selectedPaths = Array.from(checked);
  const canCommit = !busy && message.trim().length > 0 && selectedPaths.length > 0;

  async function handleCommit() {
    if (!canCommit) return;
    // FIX vs SVN Studio: it cleared the message and selection immediately, so a
    // failed commit (auth, conflict, out-of-date) threw away what you'd written.
    // Only clear once the commit has actually succeeded.
    if (await onCommit(selectedPaths, message)) {
      setMessage('');
      setChecked(new Set());
    }
  }

  function handleRevert() {
    if (selectedPaths.length === 0) return;
    // SVN Studio reverted without asking; revert discards local edits for good.
    const noun = selectedPaths.length === 1 ? `"${selectedPaths[0]}"` : `${selectedPaths.length} items`;
    if (window.confirm(`Revert ${noun}? Uncommitted changes will be permanently lost.`)) {
      onRevert(selectedPaths);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="svn-panel__header">
        <span className="svn-panel__status svn-label">
          <span className={`svn-panel__dot ${changedPaths.length > 0 ? 'svn-panel__dot--dirty' : 'svn-panel__dot--clean'}`} />
          {changedPaths.length > 0
            ? `${changedPaths.length} change${changedPaths.length === 1 ? '' : 's'}`
            : 'Clean'}
        </span>
        <button className="svn-btn" onClick={onUpdate} disabled={busy} title="svn update">
          <IconDownload size={13} /> Update
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {changedPaths.length === 0 && <div className="svn-muted-note">Working copy is clean.</div>}
        {changedPaths.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 10px 0' }}>
            <button className="svn-btn" onClick={toggleAll}>
              {checked.size === changedPaths.length ? 'Unselect all' : 'Select all'}
            </button>
          </div>
        )}
        {changesTree && (
          <ChangesTree root={changesTree} checked={checked} onToggle={handleToggle} onOpen={onOpenFile} />
        )}
      </div>

      <div className="svn-composer">
        <div className="svn-composer__actions">
          <button className="svn-pill" disabled={!canCommit} onClick={handleCommit}>
            <IconCheck size={13} /> Commit
          </button>
          <button className="svn-pill" disabled={busy} onClick={onUpdate}>
            <IconDownload size={13} /> Update
          </button>
          <button className="svn-pill" disabled={busy || selectedPaths.length === 0} onClick={handleRevert}>
            Revert
          </button>
          <button
            className={`svn-pill svn-pill--ai ${aiOpen ? 'svn-pill--active' : ''}`}
            onClick={() => setAiOpen((o) => !o)}
            aria-expanded={aiOpen}
            title="Ask the local model about the open file, a folder, or your changes"
          >
            <IconSparkle size={13} /> {aiReviewing ? 'Reviewing…' : 'AI Review'}
          </button>
        </div>
        {aiOpen && (
          <AiAssistBox
            openFilePath={openFilePath}
            checkedChanges={selectedPaths}
            folders={folders}
            busy={aiReviewing}
            modelLabel={reviewModelLabel}
            modelState={reviewModelState}
            onSubmit={onAiReview}
          />
        )}
        <div className="svn-composer__input">
          <textarea
            className="svn-textarea"
            placeholder="Describe this commit…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleCommit();
            }}
          />
          <button className="svn-send" disabled={!canCommit} onClick={() => void handleCommit()} title="Commit (Ctrl+Enter)">
            <IconSend size={15} />
          </button>
        </div>
        <div className="svn-composer__hint svn-label">
          {selectedPaths.length} of {changedPaths.length} selected · Ctrl+Enter to commit
        </div>
      </div>
    </div>
  );
}
