
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, Lock, MessageSquare, Trash2 } from 'lucide-react';
import {
  errorMessage,
  gitApi,
  type CommentFinding,
  type CommentKind,
  type CommentRemoval,
  type CommentScanResult,
} from '../../lib/git/api';
import type { RepoState } from '../../lib/git/types';
import { Modal, Spinner } from './Modal';

const KIND_ORDER: CommentKind[] = ['sensitive', 'dead-code', 'task', 'prose', 'doc', 'license', 'directive'];

const KIND_LABEL: Record<CommentKind, string> = {
  sensitive: 'Internal details',
  'dead-code': 'Commented-out code',
  task: 'TODO / FIXME',
  prose: 'Explanations',
  doc: 'Documentation',
  license: 'Licence headers',
  directive: 'Tooling directives',
};

const KIND_NOTE: Record<CommentKind, string> = {
  sensitive: 'Local paths, internal hosts, machine names — these should not be in a public repository.',
  'dead-code': 'Commented-out code. Git already remembers it.',
  task: 'Reminders left in the code.',
  prose: 'Explanations of why the code is the way it is. Removing these loses knowledge the code cannot express.',
  doc: 'API documentation on exported functions, used by editors for hover help.',
  license: 'Copyright and licence headers — kept, always.',
  directive: 'eslint-disable, @ts-ignore and friends. Removing these changes how the code builds, so they are locked.',
};

const DEFAULT_ON = new Set<CommentKind>(['sensitive', 'dead-code']);

type Phase = 'scanning' | 'results' | 'removing' | 'done';

export function CommentAuditModal({
  repo,
  onClose,
  onState,
  onNotify,
}: {
  repo: RepoState;
  onClose: () => void;
  onState: (state: RepoState) => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('scanning');
  const [scan, setScan] = useState<CommentScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<CommentKind>>(new Set(['sensitive', 'dead-code']));
  const [summary, setSummary] = useState<CommentRemoval | null>(null);
  const [error, setError] = useState('');

  const runScan = useCallback(async () => {
    setPhase('scanning');
    setError('');
    try {
      const result = await gitApi.scanComments(repo.root);
      setScan(result);
      setSelected(new Set(result.findings.filter((f) => !f.locked && DEFAULT_ON.has(f.kind)).map((f) => f.id)));
      setPhase('results');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('results');
    }
  }, [repo.root]);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  const findings = useMemo(() => scan?.findings ?? [], [scan]);
  const byKind = useMemo(() => {
    const groups = new Map<CommentKind, CommentFinding[]>();
    for (const f of findings) {
      const list = groups.get(f.kind) ?? [];
      list.push(f);
      groups.set(f.kind, list);
    }
    return groups;
  }, [findings]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleKind = (kind: CommentKind, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const f of byKind.get(kind) ?? []) {
        if (f.locked) continue;
        if (on) next.add(f.id);
        else next.delete(f.id);
      }
      return next;
    });

  const selectedFindings = findings.filter((f) => selected.has(f.id));
  const filesAffected = new Set(selectedFindings.map((f) => f.file)).size;

  const remove = async () => {
    setPhase('removing');
    setError('');
    try {
      const { result, state } = await gitApi.removeComments(repo.root, [...selected]);
      setSummary(result);
      onState(state);
      setPhase('done');
      if (result.stale) {
        onNotify('error', `${result.stale} comment(s) were skipped — those files changed since the scan.`);
      }
    } catch (err) {
      setError(errorMessage(err));
      setPhase('results');
    }
  };

  return (
    <Modal
      title="Comments in this repository"
      subtitle={
        phase === 'done'
          ? 'Removed. Review the diff before committing.'
          : 'Reads every comment in the working tree and removes only what you tick.'
      }
      onClose={onClose}
      width="wide"
    >
      <div className="gs-modal-body gs-scan-body">
        {phase === 'scanning' && (
          <div className="gs-scan-empty">
            <Loader2 className="gs-spin" size={22} />
            <p>Reading comments…</p>
          </div>
        )}

        {error && (
          <div className="gs-info-callout danger">
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        )}

        {phase === 'results' && scan && (
          <>
            <div className={`gs-scan-summary ${findings.length ? 'bad' : 'good'}`}>
              <MessageSquare size={20} />
              <div>
                <strong>
                  {scan.totalComments} comment{scan.totalComments === 1 ? '' : 's'} in {scan.filesWithComments} file
                  {scan.filesWithComments === 1 ? '' : 's'}
                </strong>
                <small>
                  {scan.totalChars.toLocaleString()} characters of {scan.sourceChars.toLocaleString()} scanned (
                  {scan.sourceChars ? ((scan.totalChars / scan.sourceChars) * 100).toFixed(1) : '0'}%) ·{' '}
                  {scan.filesScanned} file{scan.filesScanned === 1 ? '' : 's'} read
                  {scan.skipped.unsupported > 0 && ` · ${scan.skipped.unsupported} of other types skipped`}
                  {scan.truncated && ' · stopped early at the scan limit'}
                </small>
              </div>
            </div>

            <div className="gs-scan-actions">
              <span className="mono text-[10px]">
                {selected.size} selected in {filesAffected} file{filesAffected === 1 ? '' : 's'}
              </span>
              <button
                className="gs-button secondary compact"
                onClick={() => setSelected(new Set(findings.filter((f) => !f.locked).map((f) => f.id)))}
              >
                Select all removable
              </button>
              <button className="gs-button secondary compact" onClick={() => setSelected(new Set())}>
                Select none
              </button>
            </div>

            <div className="gs-scan-list">
              {KIND_ORDER.filter((k) => byKind.has(k)).map((kind) => {
                const group = byKind.get(kind)!;
                const removable = group.filter((f) => !f.locked);
                const chosen = removable.filter((f) => selected.has(f.id)).length;
                const isOpen = open.has(kind);
                return (
                  <section key={kind} className="gs-comment-group">
                    <h3>
                      <button
                        className="gs-comment-toggle"
                        onClick={() =>
                          setOpen((s) => {
                            const next = new Set(s);
                            if (next.has(kind)) next.delete(kind);
                            else next.add(kind);
                            return next;
                          })
                        }
                        aria-expanded={isOpen}
                      >
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {KIND_LABEL[kind]}
                      </button>
                      <span>{group.length}</span>
                      {removable.length > 0 ? (
                        <label className="gs-comment-all">
                          <input
                            type="checkbox"
                            checked={chosen === removable.length && chosen > 0}
                            ref={(el) => {
                              if (el) el.indeterminate = chosen > 0 && chosen < removable.length;
                            }}
                            onChange={(e) => toggleKind(kind, e.target.checked)}
                          />
                          remove all
                        </label>
                      ) : (
                        <span className="gs-comment-locked">
                          <Lock size={11} /> kept
                        </span>
                      )}
                    </h3>
                    <p className="gs-comment-note">{KIND_NOTE[kind]}</p>
                    {isOpen &&
                      group.map((f) => (
                        <label className={`gs-finding gs-comment${f.locked ? ' locked' : ''}`} key={f.id}>
                          <input
                            type="checkbox"
                            checked={selected.has(f.id)}
                            disabled={f.locked}
                            onChange={() => toggle(f.id)}
                          />
                          <span className="gs-comment-text" title={f.preview}>
                            {f.preview}
                          </span>
                          <span className="gs-finding-path" title={`${f.file}:${f.line}`}>
                            {f.file}:{f.line}
                          </span>
                          {f.detail ? (
                            <span className="gs-where staged" title={f.detail}>
                              {f.detail.split(':')[0]}
                            </span>
                          ) : (
                            <span className="gs-where">
                              {f.lines} line{f.lines === 1 ? '' : 's'}
                            </span>
                          )}
                        </label>
                      ))}
                  </section>
                );
              })}
            </div>
          </>
        )}

        {phase === 'removing' && (
          <div className="gs-scan-empty">
            <Loader2 className="gs-spin" size={22} />
            <p>Removing comments…</p>
          </div>
        )}

        {phase === 'done' && summary && (
          <div className="gs-scan-done">
            <div className="gs-scan-summary good">
              <CheckCircle2 size={20} />
              <div>
                <strong>
                  Removed {summary.removed} comment{summary.removed === 1 ? '' : 's'} from {summary.filesChanged.length}{' '}
                  file{summary.filesChanged.length === 1 ? '' : 's'}
                </strong>
                <small>
                  {summary.linesRemoved} line{summary.linesRemoved === 1 ? '' : 's'} shorter
                  {summary.stale > 0 && ` · ${summary.stale} skipped because the file had changed`}
                </small>
              </div>
            </div>
            <p className="gs-scan-note">
              Nothing is committed. The changes are in your working tree — check the diff in Changes, then commit, or
              use Discard to put it all back.
            </p>
            {summary.filesChanged.length > 0 && (
              <div className="gs-scan-list">
                <section>
                  <h3>
                    Files changed <span>{summary.filesChanged.length}</span>
                  </h3>
                  {summary.filesChanged.map((f) => (
                    <div className="gs-finding" key={f}>
                      <span className="gs-finding-path">{f}</span>
                    </div>
                  ))}
                </section>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="gs-modal-footer">
        {phase === 'results' && findings.length > 0 && (
          <>
            <button className="gs-button secondary" onClick={() => void runScan()}>
              Re-scan
            </button>
            <span className="flex-1" />
            <button className="gs-button secondary" onClick={onClose}>
              Close
            </button>
            <button className="gs-button danger" disabled={!selected.size} onClick={() => void remove()}>
              <Trash2 size={15} /> Remove {selected.size} comment{selected.size === 1 ? '' : 's'}
            </button>
          </>
        )}
        {(phase === 'scanning' || phase === 'removing') && (
          <>
            <span className="flex-1" />
            <button className="gs-button secondary" disabled>
              <Spinner size={14} /> Working…
            </button>
          </>
        )}
        {(phase === 'done' || (phase === 'results' && findings.length === 0)) && (
          <>
            <span className="flex-1" />
            <button className="gs-button primary" onClick={onClose}>
              Done
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
