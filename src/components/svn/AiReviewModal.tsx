import { useEffect, useState } from 'react';
import Markdown from '../chat/Markdown';
import { IconSparkle } from './icons';

export type AiReviewState =
  | { status: 'loading-model'; scopeLabel: string; question: string; model: string }
  | { status: 'context'; scopeLabel: string; question: string; model: string }
  | {
      status: 'streaming' | 'done';
      scopeLabel: string;
      question: string;
      model: string;
      text: string;
      fileCount: number;
      truncated: boolean;
      stopped?: boolean;
    }
  | { status: 'error'; error: string; missingModel?: boolean };

interface AiReviewModalProps {
  state: AiReviewState;
  modelProgress: number | null;
  onClose: () => void;
  onStop: () => void;
  onOpenModels: () => void;
}

const isBusy = (s: AiReviewState) =>
  s.status === 'loading-model' || s.status === 'context' || s.status === 'streaming';

export function AiReviewModal({ state, modelProgress, onClose, onStop, onOpenModels }: AiReviewModalProps) {
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const busy = isBusy(state);

  // One timer across the whole run (model load → context → generation).
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="svn-modal-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="svn-modal svn-review"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="AI review"
      >
        <div className="svn-review__header">
          <div className="svn-review__badge">
            <IconSparkle size={18} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>AI Review</h2>
            {state.status !== 'error' && (
              <div className="svn-review__meta">
                {state.scopeLabel}
                {state.question.trim() ? ` · “${state.question.trim()}”` : ' · general code review'}
              </div>
            )}
          </div>
          {state.status !== 'error' && <span className="svn-label">{state.model}</span>}
        </div>

        {state.status === 'loading-model' && (
          <div className="svn-review__progress">
            <span className="svn-spinner" />
            Loading {state.model} into the GPU
            {modelProgress != null ? ` · ${Math.round(modelProgress * 100)}%` : '…'} ({elapsed}s)
          </div>
        )}

        {state.status === 'context' && (
          <div className="svn-review__progress">
            <span className="svn-spinner" />
            Gathering files and diffs from the working copy…
          </div>
        )}

        {(state.status === 'streaming' || state.status === 'done') && (
          <>
            <div className="svn-review__meta">
              {state.fileCount} file{state.fileCount === 1 ? '' : 's'} in context
              {state.truncated ? ' · context truncated to fit the model' : ''}
              {state.status === 'streaming' ? ` · generating… ${elapsed}s` : ''}
              {state.stopped ? ' · stopped' : ''}
            </div>
            <div className="svn-review__body">
              {state.text ? (
                <Markdown>{state.text}</Markdown>
              ) : (
                <span className="svn-review__progress">
                  <span className="svn-spinner" />
                  Reading the code…
                </span>
              )}
              {state.status === 'streaming' && state.text && <span className="svn-caret" />}
            </div>
          </>
        )}

        {state.status === 'error' && <div className="svn-review__body svn-review__error">{state.error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {state.status === 'error' && state.missingModel && (
            <button className="svn-btn" onClick={onOpenModels}>
              Open Chat to add the model
            </button>
          )}
          {state.status === 'done' && state.text && (
            <button className="svn-btn" onClick={() => copy(state.text)}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {state.status === 'streaming' ? (
            <button className="svn-btn" onClick={onStop}>
              ■ Stop
            </button>
          ) : null}
          <button className="svn-btn-primary" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
