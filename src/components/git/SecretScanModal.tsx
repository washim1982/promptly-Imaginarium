// Git Studio → Scan: find credentials in the working tree and in the history,
// remove the selected ones (rewriting the affected commits), then optionally
// publish the rewritten branch.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpFromLine, CheckCircle2, FileWarning, Loader2, ShieldAlert, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { errorMessage, gitApi, type Candidate, type Finding, type RemovalSummary, type ScanResult } from '../../lib/git/api';
import type { RepoState } from '../../lib/git/types';
import { useLlm } from '../../state/LlmContext';
import { findReviewModel, REVIEW_MODEL_LABEL, stripThinking } from '../../lib/svn/review';
import { BATCH_SIZE, buildBatchPrompt, DEEP_SCAN_SYSTEM, maskValue, parseVerdicts } from '../../lib/git/deepScan';
import { Modal, Spinner } from './Modal';

const whereLabel = (where: Finding['where'], commit?: string) =>
  where === 'worktree' ? 'working tree' : where === 'staged' ? 'staged' : `history${commit ? ` · ${commit}` : ''}`;

/** A suspect the model confirmed: shown like a finding, but never pre-ticked. */
interface AiFinding {
  id: string;
  kind: string;
  path: string;
  line: number;
  where: 'worktree' | 'history';
  commit?: string;
  masked: string;
}

type DeepState =
  | { phase: 'idle' }
  | { phase: 'collecting' }
  | { phase: 'loading-model'; model: string }
  | { phase: 'asking'; done: number; total: number }
  | { phase: 'done'; considered: number; asked: number }
  | { phase: 'error'; message: string };

type Phase = 'scanning' | 'results' | 'confirm' | 'removing' | 'done';

/**
 * 'staged' looks only at what the next commit would record; 'full' looks at
 * every file and every blob in the history. Only the full scan can remove
 * anything — staged values are not in the history yet, so there is nothing to
 * rewrite; you fix the file or unstage it.
 */
export type ScanMode = 'staged' | 'full';

export function SecretScanModal({
  repo,
  onClose,
  onState,
  onNotify,
  initialMode = 'full',
  initialScan,
  gate,
}: {
  repo: RepoState;
  onClose: () => void;
  onState: (state: RepoState) => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
  initialMode?: ScanMode;
  /** A staged scan already run by the caller, so the gate opens instantly. */
  initialScan?: ScanResult;
  /** Present when this is the check in front of a commit. */
  gate?: { onCommitAnyway: () => void };
}) {
  const [mode, setMode] = useState<ScanMode>(initialMode);
  const [phase, setPhase] = useState<Phase>(initialScan ? 'results' : 'scanning');
  const [scan, setScan] = useState<ScanResult | null>(initialScan ?? null);
  const [unstaging, setUnstaging] = useState(false);
  // Seeded from a handed-in scan too: that path skips runScan, which is what
  // normally ticks everything.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialScan?.findings.map((f) => f.id) ?? []),
  );
  const [summary, setSummary] = useState<RemovalSummary | null>(null);
  const [error, setError] = useState('');
  const [pushed, setPushed] = useState(false);
  const remote = repo.remotes[0]?.name ?? '';

  // ---- deep scan (optional, local model) ----
  const llm = useLlm();
  const latest = useRef(llm);
  latest.current = llm;
  const [deep, setDeep] = useState<DeepState>({ phase: 'idle' });
  const [aiFindings, setAiFindings] = useState<AiFinding[]>([]);
  const deepModel = findReviewModel(llm.models);

  const runDeepScan = async () => {
    setAiFindings([]);
    setDeep({ phase: 'collecting' });
    try {
      const { candidates, linesConsidered } = await gitApi.scanCandidates(repo.root);
      if (!candidates.length) {
        setDeep({ phase: 'done', considered: linesConsidered, asked: 0 });
        return;
      }
      const target = deepModel;
      if (!target) {
        setDeep({ phase: 'error', message: `${REVIEW_MODEL_LABEL} is not in your model library — add it in Chat to use the deep scan.` });
        return;
      }
      if (!(latest.current.activeModel?.id === target.id && latest.current.status === 'ready')) {
        setDeep({ phase: 'loading-model', model: target.label });
        const ok = await latest.current.loadModel({ type: 'library', id: target.id });
        if (!ok) {
          await new Promise((r) => setTimeout(r, 0));
          setDeep({ phase: 'error', message: `Couldn't load ${target.label}: ${latest.current.error ?? 'unknown error'}` });
          return;
        }
      }

      const batches: Candidate[][] = [];
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) batches.push(candidates.slice(i, i + BATCH_SIZE));
      const confirmed: AiFinding[] = [];
      for (const [index, batch] of batches.entries()) {
        setDeep({ phase: 'asking', done: index, total: batches.length });
        let raw = '';
        for await (const token of latest.current.generate(buildBatchPrompt(batch), DEEP_SCAN_SYSTEM)) raw += token;
        const verdicts = parseVerdicts(stripThinking(raw), batch.length);
        batch.forEach((candidate, i) => {
          const verdict = verdicts.get(i + 1);
          if (!verdict?.secret) return;
          confirmed.push({
            id: candidate.id,
            kind: verdict.kind,
            path: candidate.path,
            line: candidate.line,
            where: candidate.where,
            commit: candidate.commit,
            masked: maskValue(candidate.value),
          });
        });
        setAiFindings([...confirmed]);
      }
      setDeep({ phase: 'done', considered: linesConsidered, asked: candidates.length });
    } catch (err) {
      setDeep({ phase: 'error', message: errorMessage(err) });
    }
  };

  const runScan = useCallback(async () => {
    setPhase('scanning');
    setError('');
    setAiFindings([]);
    setDeep({ phase: 'idle' });
    try {
      const result = mode === 'staged' ? await gitApi.scanStaged(repo.root) : await gitApi.scanSecrets(repo.root);
      setScan(result);
      setSelected(new Set(result.findings.map((f) => f.id)));
      setPhase('results');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('results');
    }
  }, [repo.root, mode]);

  // A scan handed in by the caller is already the right one; don't redo it.
  const skipFirst = useRef(Boolean(initialScan));
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    void runScan();
  }, [runScan]);

  /** Staged mode's fix: take the offending files back out of the commit. */
  const unstageFindings = async () => {
    const paths = [...new Set(findings.filter((f) => selected.has(f.id)).map((f) => f.path))];
    if (!paths.length) return;
    setUnstaging(true);
    try {
      const result = await gitApi.unstage(repo.root, paths);
      if (result.state) onState(result.state);
      onNotify('success', result.message || `Unstaged ${paths.length} file${paths.length === 1 ? '' : 's'}.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUnstaging(false);
    }
  };

  const remove = async () => {
    setPhase('removing');
    setError('');
    try {
      const { summary: result, state } = await gitApi.removeSecrets(repo.root, [...selected]);
      setSummary(result);
      onState(state);
      setPhase('done');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('results');
    }
  };

  const push = async () => {
    try {
      const { message, state } = await gitApi.forcePush(repo.root, remote, repo.branch);
      onState(state);
      onNotify('success', message);
      setPushed(true);
    } catch (err) {
      onNotify('error', errorMessage(err));
    }
  };

  const findings = scan?.findings ?? [];
  const byRule = findings.reduce<Record<string, Finding[]>>((acc, f) => {
    (acc[f.ruleLabel] ??= []).push(f);
    return acc;
  }, {});
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      title={gate ? 'Credentials in your staged changes' : 'Scan for credentials'}
      subtitle={
        phase === 'done'
          ? 'Removal finished.'
          : gate
            ? 'Found before the commit was made — nothing has been committed.'
            : mode === 'staged'
              ? 'Looks only at what your next commit would record.'
              : 'Looks through your files and every commit for tokens, keys and passwords.'
      }
      onClose={onClose}
      width="wide"
    >
      <div className="gs-modal-body gs-scan-body">
        {!gate && (
          <div className="gs-scan-tabs" role="tablist" aria-label="What to scan">
            <button
              role="tab"
              aria-selected={mode === 'staged'}
              className={`gs-button compact ${mode === 'staged' ? 'primary' : 'secondary'}`}
              disabled={phase === 'scanning' || phase === 'removing'}
              onClick={() => setMode('staged')}
            >
              Staged changes
            </button>
            <button
              role="tab"
              aria-selected={mode === 'full'}
              className={`gs-button compact ${mode === 'full' ? 'primary' : 'secondary'}`}
              disabled={phase === 'scanning' || phase === 'removing'}
              onClick={() => setMode('full')}
            >
              Whole repository &amp; history
            </button>
          </div>
        )}

        {phase === 'scanning' && (
          <div className="gs-scan-empty">
            <Loader2 className="gs-spin" size={22} />
            <p>{mode === 'staged' ? 'Scanning what is staged…' : 'Scanning the working tree and every commit…'}</p>
          </div>
        )}

        {error && (
          <div className="gs-info-callout danger">
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        )}

        {(phase === 'results' || phase === 'confirm') && scan && (
          <>
            <div className={`gs-scan-summary ${findings.length ? 'bad' : 'good'}`}>
              {findings.length ? <ShieldAlert size={20} /> : <ShieldCheck size={20} />}
              <div>
                <strong>
                  {findings.length
                    ? `${scan.secretCount} credential${scan.secretCount === 1 ? '' : 's'} in ${findings.length} place${findings.length === 1 ? '' : 's'}`
                    : 'No credentials found'}
                </strong>
                <small>
                  {mode === 'staged'
                    ? `Scanned ${scan.filesScanned} staged file${scan.filesScanned === 1 ? '' : 's'}`
                    : `Scanned ${scan.filesScanned} file${scan.filesScanned === 1 ? '' : 's'} and ${scan.blobsScanned} version${scan.blobsScanned === 1 ? '' : 's'} in history`}
                  {scan.skipped.large + scan.skipped.binary > 0 &&
                    ` · skipped ${scan.skipped.large} too large, ${scan.skipped.binary} binary`}
                  {scan.truncated && ' · stopped early at the scan limit'}
                </small>
              </div>
            </div>

            {findings.length > 0 && phase === 'results' && (
              <>
                <div className="gs-scan-actions">
                  <span className="mono text-[10px]">{selected.size} selected</span>
                  <button className="gs-button secondary compact" onClick={() => setSelected(new Set(findings.map((f) => f.id)))}>
                    Select all
                  </button>
                  <button className="gs-button secondary compact" onClick={() => setSelected(new Set())}>
                    Select none
                  </button>
                </div>
                <div className="gs-scan-list">
                  {Object.entries(byRule).map(([label, group]) => (
                    <section key={label}>
                      <h3>
                        {label} <span>{group.length}</span>
                      </h3>
                      {group.map((f) => (
                        <label className="gs-finding" key={f.id}>
                          <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                          <code>{f.masked}</code>
                          <span className="gs-finding-path" title={`${f.path}:${f.line}`}>
                            {f.path}:{f.line}
                          </span>
                          <span className={`gs-where ${f.where}`}>
                            {whereLabel(f.where, f.commit)}
                          </span>
                        </label>
                      ))}
                    </section>
                  ))}
                </div>
              </>
            )}

            {/* The AI pass works off the full scan's candidate list. */}
            {phase === 'results' && mode === 'full' && (
              <div className="gs-deep">
                <div className="gs-deep-head">
                  <div>
                    <strong>
                      <Sparkles size={14} /> Deep scan with AI
                    </strong>
                    <small>
                      The pattern scan above only knows known formats. This asks the local model about lines that look
                      like they could hold a credential — odd formats, unusual names. It runs on this PC and adds
                      suspects for you to confirm; it never unticks anything above.
                    </small>
                  </div>
                  <button
                    className="gs-button secondary"
                    disabled={deep.phase === 'collecting' || deep.phase === 'loading-model' || deep.phase === 'asking'}
                    onClick={() => void runDeepScan()}
                  >
                    {deep.phase === 'done' || deep.phase === 'error' ? 'Run again' : 'Run deep scan'}
                  </button>
                </div>

                {deep.phase === 'collecting' && (
                  <p className="gs-scan-note">
                    <Loader2 className="gs-spin" size={13} /> Collecting lines to check…
                  </p>
                )}
                {deep.phase === 'loading-model' && (
                  <p className="gs-scan-note">
                    <Loader2 className="gs-spin" size={13} /> Loading {deep.model}…
                  </p>
                )}
                {deep.phase === 'asking' && (
                  <p className="gs-scan-note">
                    <Loader2 className="gs-spin" size={13} /> Asking {llm.activeModel?.label ?? REVIEW_MODEL_LABEL}: batch{' '}
                    {deep.done + 1} of {deep.total}…
                  </p>
                )}
                {deep.phase === 'error' && (
                  <div className="gs-info-callout danger">
                    <AlertTriangle size={17} />
                    <span>{deep.message}</span>
                  </div>
                )}
                {deep.phase === 'done' && (
                  <p className="gs-scan-note">
                    {deep.asked === 0
                      ? 'Nothing suspicious left for the model to check.'
                      : `Checked ${deep.asked} value${deep.asked === 1 ? '' : 's'} from ${deep.considered} line${deep.considered === 1 ? '' : 's'} · ${aiFindings.length} flagged.`}
                  </p>
                )}

                {aiFindings.length > 0 && (
                  <div className="gs-scan-list">
                    <section>
                      <h3>
                        Flagged by the model — check each one <span>{aiFindings.length}</span>
                      </h3>
                      {aiFindings.map((f) => (
                        <label className="gs-finding" key={f.id}>
                          <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                          <code>{f.masked}</code>
                          <span className="gs-finding-path" title={`${f.path}:${f.line}`}>
                            {f.path}:{f.line}
                            {f.kind && <em className="gs-ai-kind"> · {f.kind}</em>}
                          </span>
                          <span className={`gs-where ${f.where}`}>
                            {whereLabel(f.where, f.commit)}
                          </span>
                        </label>
                      ))}
                    </section>
                  </div>
                )}
              </div>
            )}

            {phase === 'confirm' && (
              <div className="gs-scan-confirm">
                <div className="gs-info-callout danger">
                  <AlertTriangle size={17} />
                  <span>
                    This rewrites every commit that contains the {selected.size} selected item
                    {selected.size === 1 ? '' : 's'}. Commit hashes after that point change, and anyone else with a clone
                    must re-clone.
                  </span>
                </div>
                <ul className="gs-scan-facts">
                  <li>A full backup of the current history is saved inside <code>.git</code> first.</li>
                  <li>Messages, authors and dates are preserved; the values become <code>***REMOVED***</code>.</li>
                  <li>Your uncommitted changes are kept.</li>
                  <li>
                    <b>Rotate these credentials anyway.</b> Anything already pushed or cloned must be treated as leaked.
                  </li>
                </ul>
              </div>
            )}
          </>
        )}

        {phase === 'removing' && (
          <div className="gs-scan-empty">
            <Loader2 className="gs-spin" size={22} />
            <p>Rewriting history…</p>
          </div>
        )}

        {phase === 'done' && summary && (
          <div className="gs-scan-done">
            <div className="gs-scan-summary good">
              <CheckCircle2 size={20} />
              <div>
                <strong>
                  {summary.historyRewritten
                    ? `Rewrote ${summary.commitsRewritten} commit${summary.commitsRewritten === 1 ? '' : 's'}`
                    : 'Removed from your files'}
                </strong>
                <small>
                  {summary.filesChanged.length} file{summary.filesChanged.length === 1 ? '' : 's'} changed on disk ·{' '}
                  {summary.blobsRewritten} stored version{summary.blobsRewritten === 1 ? '' : 's'} rewritten
                  {summary.refsUpdated.length > 0 && ` · ${summary.refsUpdated.length} branch(es) moved`}
                </small>
              </div>
            </div>
            {summary.backupPath && (
              <p className="gs-scan-note">
                Backup of the old history: <code>{summary.backupPath}</code>
              </p>
            )}
            {summary.tagsSkipped.length > 0 && (
              <p className="gs-scan-note">
                <FileWarning size={13} /> Tags still point at the old commits: {summary.tagsSkipped.join(', ')}
              </p>
            )}
            {summary.signaturesDropped > 0 && (
              <p className="gs-scan-note">
                <FileWarning size={13} /> {summary.signaturesDropped} commit signature(s) dropped — signatures can't
                cover rewritten content.
              </p>
            )}
            <div className="gs-info-callout danger">
              <AlertTriangle size={17} />
              <span>
                Rotate the credentials you just removed. Copies may exist in clones, forks, CI logs or backups.
              </span>
            </div>
            {summary.historyRewritten && remote && !pushed && (
              <p className="gs-scan-note">
                <FileWarning size={13} /> Until you force-push, your local copy still keeps the old commits: they stay
                reachable through <code>{remote}/{repo.branch}</code>.
              </p>
            )}
            {summary.historyRewritten && remote && (
              <div className="gs-scan-push">
                <div>
                  <strong>Publish the rewritten history</strong>
                  <small>
                    Force-pushes <code>{repo.branch}</code> to <code>{remote}</code>. Refused if someone else pushed
                    since your last fetch.
                  </small>
                </div>
                <button className="gs-button danger" disabled={pushed} onClick={() => void push()}>
                  <ArrowUpFromLine size={15} /> {pushed ? 'Pushed' : 'Force-push'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="gs-modal-footer">
        {/* Staged findings aren't in the history, so there is nothing to
            rewrite: fix the file, or take it back out of the commit. */}
        {phase === 'results' && mode === 'staged' && findings.length > 0 && (
          <>
            <button className="gs-button secondary" disabled={unstaging} onClick={() => void runScan()}>
              Re-scan
            </button>
            <span className="flex-1" />
            <button className="gs-button secondary" disabled={unstaging} onClick={onClose}>
              {gate ? 'Cancel commit' : 'Close'}
            </button>
            <button
              className="gs-button secondary"
              disabled={!selected.size || unstaging}
              onClick={() => void unstageFindings()}
            >
              {unstaging ? <Spinner size={14} /> : <FileWarning size={15} />} Unstage{' '}
              {new Set(findings.filter((f) => selected.has(f.id)).map((f) => f.path)).size} file(s)
            </button>
            {gate && (
              <button
                className="gs-button danger"
                disabled={unstaging}
                onClick={() => {
                  gate.onCommitAnyway();
                  onClose();
                }}
              >
                Commit anyway
              </button>
            )}
          </>
        )}

        {phase === 'results' && mode === 'full' && (findings.length > 0 || aiFindings.length > 0) && (
          <>
            <button className="gs-button secondary" onClick={() => void runScan()}>
              Re-scan
            </button>
            <span className="flex-1" />
            <button className="gs-button secondary" onClick={onClose}>
              Close
            </button>
            <button className="gs-button danger" disabled={!selected.size} onClick={() => setPhase('confirm')}>
              <Trash2 size={15} /> Remove {selected.size} selected…
            </button>
          </>
        )}
        {phase === 'confirm' && (
          <>
            <button className="gs-button secondary" onClick={() => setPhase('results')}>
              Back
            </button>
            <span className="flex-1" />
            <button className="gs-button danger" onClick={() => void remove()}>
              <Trash2 size={15} /> Yes, remove and rewrite history
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
        {(phase === 'done' || (phase === 'results' && findings.length === 0 && aiFindings.length === 0)) && (
          <>
            <span className="flex-1" />
            {/* Re-scanned during the gate and now clean: let the commit through. */}
            {gate && phase === 'results' ? (
              <>
                <button className="gs-button secondary" onClick={onClose}>
                  Cancel commit
                </button>
                <button
                  className="gs-button primary"
                  onClick={() => {
                    gate.onCommitAnyway();
                    onClose();
                  }}
                >
                  Commit now
                </button>
              </>
            ) : (
              <button className="gs-button primary" onClick={onClose}>
                Done
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
