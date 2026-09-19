import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiScope } from '../../lib/svn/types';
import { baseName, parentOf } from '../../lib/svn/utils';
import { IconPlus, IconSend } from './icons';

type ScopeItem = { kind: 'file' | 'folder' | 'changes'; path: string };

/** Whether the pinned review model is loaded, loadable, or absent. */
export type ReviewModelState = 'ready' | 'will-load' | 'missing';

interface AiAssistBoxProps {
  openFilePath: string | null;
  checkedChanges: string[];
  folders: string[];
  busy: boolean;
  modelLabel: string;
  modelState: ReviewModelState;
  onSubmit: (scope: AiScope, question: string, scopeLabel: string) => void;
}

const folderLabel = (p: string) => (p === '' ? 'Whole working copy' : baseName(p));

const MODEL_NOTE: Record<ReviewModelState, string> = {
  ready: 'loaded',
  'will-load': 'loads on send',
  missing: 'not in model library',
};

export function AiAssistBox({
  openFilePath,
  checkedChanges,
  folders,
  busy,
  modelLabel,
  modelState,
  onSubmit,
}: AiAssistBoxProps) {
  const [question, setQuestion] = useState('');
  const [manual, setManual] = useState<ScopeItem[]>([]);
  // The open file is in scope by default; this remembers if the user removed it
  // for *that* file, so opening a different file brings the default back.
  const [autoRemovedFor, setAutoRemovedFor] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [folderFilter, setFolderFilter] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen && !pickerOpen) return;
    function onDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen, pickerOpen]);

  const autoFile = openFilePath && autoRemovedFor !== openFilePath ? openFilePath : null;
  const items: (ScopeItem & { auto?: boolean })[] = useMemo(() => {
    const list: (ScopeItem & { auto?: boolean })[] = [];
    if (autoFile && !manual.some((m) => m.kind === 'file' && m.path === autoFile)) {
      list.push({ kind: 'file', path: autoFile, auto: true });
    }
    return [...list, ...manual];
  }, [autoFile, manual]);

  const has = (kind: ScopeItem['kind'], p: string) => items.some((i) => i.kind === kind && i.path === p);

  function addItem(item: ScopeItem) {
    if (!has(item.kind, item.path)) setManual((m) => [...m, item]);
    if (item.kind === 'file' && item.path === openFilePath) setAutoRemovedFor(null);
    setMenuOpen(false);
    setPickerOpen(false);
    textareaRef.current?.focus();
  }

  function removeItem(item: ScopeItem & { auto?: boolean }) {
    if (item.auto) setAutoRemovedFor(item.path);
    else setManual((m) => m.filter((x) => !(x.kind === item.kind && x.path === item.path)));
    if (item.kind === 'file' && item.path === openFilePath) setAutoRemovedFor(item.path);
  }

  const scope: AiScope = {
    files: items.filter((i) => i.kind === 'file').map((i) => i.path),
    folders: items.filter((i) => i.kind === 'folder').map((i) => i.path),
    changes: items.some((i) => i.kind === 'changes') ? checkedChanges : [],
  };
  const scopeEmpty = scope.files.length + scope.folders.length + scope.changes.length === 0;
  const canSend = !busy && !scopeEmpty && modelState !== 'missing';

  function submit() {
    if (!canSend) return;
    const label = items
      .map((i) =>
        i.kind === 'changes'
          ? `${checkedChanges.length} change(s)`
          : i.kind === 'folder'
            ? folderLabel(i.path)
            : baseName(i.path),
      )
      .join(', ');
    onSubmit(scope, question, label);
  }

  const filteredFolders = useMemo(() => {
    const q = folderFilter.trim().toLowerCase();
    return ['', ...folders].filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 60);
  }, [folders, folderFilter]);

  return (
    <div className="svn-ai-box">
      <div className="svn-ai-box__model-note" title="AI review always runs on this model, locally">
        <span
          className={`svn-ai-box__model-dot ${
            modelState === 'ready'
              ? 'svn-ai-box__model-dot--ready'
              : modelState === 'missing'
                ? 'svn-ai-box__model-dot--missing'
                : ''
          }`}
        />
        {modelLabel} · {MODEL_NOTE[modelState]}
      </div>

      <div className="svn-ai-chips">
        {items.length === 0 && <span className="svn-ai-hint">No scope — open a file or use + to add a folder</span>}
        {items.map((item) => (
          <span
            key={`${item.kind}:${item.path}`}
            className="svn-ai-chip"
            title={item.kind === 'changes' ? checkedChanges.join('\n') : item.path || 'Whole working copy'}
          >
            <span>{item.kind === 'file' ? '▤' : item.kind === 'folder' ? '▣' : '±'}</span>
            <span className="svn-ai-chip__label">
              {item.kind === 'changes'
                ? `Changes (${checkedChanges.length})`
                : item.kind === 'folder'
                  ? folderLabel(item.path)
                  : baseName(item.path)}
            </span>
            {item.auto && <span className="svn-ai-chip__tag">open</span>}
            <button className="svn-ai-chip__remove" onClick={() => removeItem(item)} title="Remove from scope">
              ×
            </button>
          </span>
        ))}
      </div>

      <textarea
        ref={textareaRef}
        className="svn-ai-input"
        placeholder="Ask anything, or leave blank for a code review…"
        value={question}
        rows={2}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <div className="svn-ai-footer">
        <div className="svn-ai-left" ref={popoverRef}>
          <button
            className="svn-ai-plus"
            onClick={() => {
              setMenuOpen((o) => !o);
              setPickerOpen(false);
            }}
            title="Add to review scope"
          >
            <IconPlus size={14} />
          </button>

          {menuOpen && (
            <div className="svn-ai-pop">
              <button
                className="svn-ai-pop__item"
                disabled={!openFilePath || has('file', openFilePath)}
                onClick={() => openFilePath && addItem({ kind: 'file', path: openFilePath })}
              >
                ▤ Open file{openFilePath ? `: ${baseName(openFilePath)}` : ' (none open)'}
              </button>
              {openFilePath && parentOf(openFilePath) !== '' && (
                <button
                  className="svn-ai-pop__item"
                  disabled={has('folder', parentOf(openFilePath))}
                  onClick={() => addItem({ kind: 'folder', path: parentOf(openFilePath) })}
                >
                  ▣ Folder of open file: {baseName(parentOf(openFilePath))}
                </button>
              )}
              <button
                className="svn-ai-pop__item"
                onClick={() => {
                  setMenuOpen(false);
                  setPickerOpen(true);
                  setFolderFilter('');
                }}
              >
                ▣ Working folder…
              </button>
              <button
                className="svn-ai-pop__item"
                disabled={checkedChanges.length === 0 || has('changes', '')}
                onClick={() => addItem({ kind: 'changes', path: '' })}
              >
                ± Checked changes ({checkedChanges.length})
              </button>
            </div>
          )}

          {pickerOpen && (
            <div className="svn-ai-pop">
              <input
                autoFocus
                className="svn-ai-pop__filter"
                placeholder="Filter folders…"
                value={folderFilter}
                onChange={(e) => setFolderFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setPickerOpen(false);
                  if (e.key === 'Enter' && filteredFolders.length > 0) {
                    addItem({ kind: 'folder', path: filteredFolders[0] });
                  }
                }}
              />
              <div className="svn-ai-pop__list">
                {filteredFolders.map((f) => (
                  <button
                    key={f || '(root)'}
                    className="svn-ai-pop__item"
                    disabled={has('folder', f)}
                    onClick={() => addItem({ kind: 'folder', path: f })}
                    title={f || 'Whole working copy'}
                  >
                    ▣ {f === '' ? 'Whole working copy' : f}
                  </button>
                ))}
                {filteredFolders.length === 0 && <div className="svn-ai-hint">No matching folders</div>}
              </div>
            </div>
          )}
        </div>

        <button className="svn-ai-send" disabled={!canSend} onClick={submit} title="Run AI review (Enter)">
          {busy ? <span className="svn-spinner" /> : <IconSend size={14} />}
        </button>
      </div>
    </div>
  );
}
