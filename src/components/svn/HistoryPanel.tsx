import type { SvnLogEntry } from '../../lib/svn/types';
import { IconLock, IconUnlock } from './icons';

interface HistoryPanelProps {
  entries: SvnLogEntry[];
  loading: boolean;
  scopedPath: string | null;
  onClose: () => void;
  onLockToggle: (path: string, lock: boolean) => void;
}

const ACTION_LABEL: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'replaced' };

export function HistoryPanel({ entries, loading, scopedPath, onClose, onLockToggle }: HistoryPanelProps) {
  return (
    <div className="svn-history" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="svn-panel__header">
        <span className="svn-label" title={scopedPath ?? 'Whole working copy'}>
          History{scopedPath ? ` · ${scopedPath}` : ''}
        </span>
        <button className="svn-btn" onClick={onClose} aria-label="Close history">
          ✕
        </button>
      </div>
      {scopedPath && (
        <div style={{ display: 'flex', gap: 6, padding: '10px 12px 4px' }}>
          <button className="svn-btn" onClick={() => onLockToggle(scopedPath, true)}>
            <IconLock size={13} /> Lock
          </button>
          <button className="svn-btn" onClick={() => onLockToggle(scopedPath, false)}>
            <IconUnlock size={13} /> Unlock
          </button>
        </div>
      )}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {loading && <div className="svn-muted-note">Loading history…</div>}
        {!loading && entries.length === 0 && <div className="svn-muted-note">No revisions found.</div>}
        {entries.map((entry) => (
          <div key={entry.revision} className="svn-history__entry">
            <div className="svn-history__meta">
              <span className="svn-history__rev">r{entry.revision}</span>
              <span>{entry.date ? new Date(entry.date).toLocaleString() : ''}</span>
            </div>
            <div className="svn-history__author">{entry.author}</div>
            <div className="svn-history__msg">{entry.message || '(no message)'}</div>
            {entry.paths.length > 0 && (
              <details>
                <summary>
                  {entry.paths.length} path{entry.paths.length === 1 ? '' : 's'} changed
                </summary>
                <ul className="svn-history__paths">
                  {entry.paths.map((p, i) => (
                    <li key={i} title={ACTION_LABEL[p.action] ?? p.action}>
                      [{p.action}] {p.path}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
