import { useRef, useState } from 'react';
import { useLlm } from '../state/LlmContext';
import { MODELS } from '../lib/models';
import {
  runDeepResearch,
  AGENT_META,
  type CriticVerdict,
  type DeepEvent,
  type Todo,
  type VfsFile,
} from '../lib/deepAgents';
import DeepCell, { type TaskCellData } from '../components/research/DeepCell';
import ModelLoader from '../components/chat/ModelLoader';
import Markdown from '../components/chat/Markdown';
import { webSearch, webExtract } from '../lib/search';

interface ReviewNote {
  round: number;
  decision: string;
  reason: string;
}

const VERDICT_STYLE: Record<CriticVerdict, string> = {
  SOUND: 'text-emerald-300 border-emerald-400/30',
  MINOR_ISSUES: 'text-amber-300 border-amber-400/30',
  MAJOR_ISSUES: 'text-rose-300 border-rose-400/30',
};

export default function Research() {
  const { status, generate, cancel, gpu, activeModelId } = useLlm();

  const [topic, setTopic] = useState('');
  const [running, setRunning] = useState(false);
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [maxRevisions, setMaxRevisions] = useState(1);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [deepVerify, setDeepVerify] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Live state mirrored from the engine's events.
  const [question, setQuestion] = useState('');
  const [plan, setPlan] = useState<{ raw: string; done: boolean }>({ raw: '', done: false });
  const [todos, setTodos] = useState<Todo[]>([]);
  const [tasks, setTasks] = useState<Record<string, TaskCellData>>({});
  const [files, setFiles] = useState<VfsFile[]>([]);
  const [reviews, setReviews] = useState<ReviewNote[]>([]);
  const [verdict, setVerdict] = useState<CriticVerdict | null>(null);
  const [final, setFinal] = useState<{ raw: string; done: boolean } | null>(null);

  const runningRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  function scroll() {
    endRef.current?.scrollIntoView({ block: 'end' });
  }

  function handleEvent(e: DeepEvent) {
    switch (e.type) {
      case 'plan:start':
        setPlan({ raw: '', done: false });
        break;
      case 'plan:token':
        setPlan((p) => ({ ...p, raw: e.raw }));
        break;
      case 'plan:done':
        setQuestion(e.question);
        setTodos(e.todos);
        setPlan((p) => ({ ...p, done: true }));
        break;
      case 'todos':
        setTodos(e.todos);
        break;
      case 'task:start':
        setTasks((m) => ({
          ...m,
          [e.todo.id]: {
            todoId: e.todo.id,
            agent: e.todo.agent,
            title: e.todo.title,
            round: e.todo.round,
            status: 'streaming',
            raw: '',
          },
        }));
        scroll();
        break;
      case 'task:token':
        setTasks((m) =>
          m[e.todoId] ? { ...m, [e.todoId]: { ...m[e.todoId], raw: e.raw } } : m,
        );
        scroll();
        break;
      case 'task:done':
        setTasks((m) =>
          m[e.todoId]
            ? {
                ...m,
                [e.todoId]: { ...m[e.todoId], status: 'done', summary: e.summary, file: e.file },
              }
            : m,
        );
        break;
      case 'citations':
        setTasks((m) =>
          m[e.todoId]
            ? {
                ...m,
                [e.todoId]: {
                  ...m[e.todoId],
                  citations: { verified: e.verified, unverified: e.unverified },
                },
              }
            : m,
        );
        break;
      case 'entailment':
        setTasks((m) =>
          m[e.todoId]
            ? {
                ...m,
                [e.todoId]: {
                  ...m[e.todoId],
                  claims: { supported: e.supported, partial: e.partial, notFound: e.notFound },
                },
              }
            : m,
        );
        break;
      case 'verdict':
        setVerdict(e.verdict);
        break;
      case 'search:start':
        setTasks((m) =>
          m[e.todoId] ? { ...m, [e.todoId]: { ...m[e.todoId], search: '🔎 searching the web…' } } : m,
        );
        break;
      case 'search:done':
        setTasks((m) =>
          m[e.todoId] ? { ...m, [e.todoId]: { ...m[e.todoId], search: `🔎 ${e.count} sources` } } : m,
        );
        break;
      case 'search:error':
        setTasks((m) =>
          m[e.todoId] ? { ...m, [e.todoId]: { ...m[e.todoId], search: '🔎 web unavailable' } } : m,
        );
        break;
      case 'fs':
        setFiles(e.files);
        break;
      case 'review:done':
        setReviews((r) => [...r, { round: e.round, decision: e.decision, reason: e.reason }]);
        break;
      case 'final:start':
        setFinal({ raw: '', done: false });
        scroll();
        break;
      case 'final:token':
        setFinal({ raw: e.raw, done: false });
        scroll();
        break;
      case 'final:done':
        setFinal({ raw: e.report, done: true });
        break;
      case 'done':
        setStopReason(e.reason);
        break;
    }
  }

  async function run() {
    if (status !== 'ready' || running || !topic.trim()) return;
    setQuestion('');
    setPlan({ raw: '', done: false });
    setTodos([]);
    setTasks({});
    setFiles([]);
    setReviews([]);
    setVerdict(null);
    setFinal(null);
    setStopReason(null);
    setRunning(true);
    runningRef.current = true;
    try {
      await runDeepResearch({
        topic: topic.trim(),
        maxRevisions,
        generate,
        isCancelled: () => !runningRef.current,
        onEvent: handleEvent,
        webSearch: webSearchEnabled ? (q) => webSearch(q) : undefined,
        webExtract:
          webSearchEnabled && deepVerify ? (urls) => webExtract(urls) : undefined,
      });
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }

  function stop() {
    runningRef.current = false;
    cancel();
  }

  function downloadReport() {
    const report = final?.raw || '';
    const fs = files.map((f) => `\n\n---\n\n## ${f.name}\n\n${f.content}`).join('');
    const md = `# Deep Research Report\n\n**Topic:** ${topic}\n\n**Research question:** ${question}\n\n${report}\n\n\n---\n# Appendix — Agent file system${fs}`;
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'deep-research-report.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Group task cells by round for rendering.
  const rounds = Array.from(new Set(todos.map((t) => t.round))).sort((a, b) => a - b);

  // ---- Gates -------------------------------------------------------------
  if (status === 'checking-gpu') {
    return (
      <Wrap>
        <p className="mono text-sm text-white/50">Checking GPU support…</p>
      </Wrap>
    );
  }
  if (status !== 'ready') {
    return (
      <Wrap>
        <p className="mb-6 text-center text-sm text-white/55">
          Load a model to run the deep-research system — everything runs locally.
        </p>
        <ModelLoader />
        {gpu?.adapter && (
          <p className="mono mt-4 text-[10px] text-white/30">GPU: {gpu.adapter}</p>
        )}
      </Wrap>
    );
  }

  const doneCount = todos.filter((t) => t.status === 'done').length;

  // ---- Main UI -----------------------------------------------------------
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col">
      <div className="px-4 pt-5">
        <h1 className="text-2xl font-semibold text-white">Deep Research</h1>
        <p className="text-sm text-white/45">
          PhD-grade pipeline — the Orchestrator decomposes your question; isolated Researchers
          gather cited evidence (OrioSearch); an Analyst synthesizes; an adversarial Critic
          verifies citations and rigor; corrections loop until sound. Fully local on Gemma.
        </p>

        <div className="glass neon-glow mt-4 flex items-center gap-2 rounded-xl px-3 py-2">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !running) run();
            }}
            placeholder="Research question — e.g. “Do LLM agents improve software engineering productivity?”"
            className="flex-1 bg-transparent text-[15px] text-white placeholder:text-white/35 focus:outline-none"
          />
          {running ? (
            <button
              onClick={stop}
              className="rounded-lg bg-red-500/80 px-3 py-1.5 text-sm text-white hover:bg-red-500"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={run}
              disabled={!topic.trim()}
              className="neon-glow rounded-lg bg-[var(--color-neon)] px-4 py-1.5 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-30"
            >
              Run
            </button>
          )}
        </div>

        <div className="relative mt-2 flex items-center gap-3 px-1">
          <span className="mono inline-flex items-center gap-2 text-[11px] text-white/55">
            <span
              className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-[var(--color-neon)]' : 'bg-white/30'}`}
            />
            {MODELS[activeModelId].label} · {maxRevisions} revision{maxRevisions === 1 ? '' : 's'}
            {webSearchEnabled && ' · web ✓'}
            {todos.length > 0 && ` · ${doneCount}/${todos.length} tasks`}
          </span>
          {verdict && (
            <span className={`mono rounded border px-1.5 py-0.5 text-[9px] ${VERDICT_STYLE[verdict]}`}>
              {verdict.replace('_', ' ')}
            </span>
          )}
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className="mono text-[11px] text-white/40 hover:text-white"
          >
            ⚙ settings
          </button>
          {(final?.raw || files.length > 0) && (
            <button
              onClick={downloadReport}
              className="mono ml-auto text-[11px] text-[var(--color-teal)] hover:underline"
            >
              ⭳ Download report
            </button>
          )}

          {settingsOpen && (
            <div className="glass absolute right-0 top-7 z-20 w-72 rounded-xl p-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="mono text-[10px] text-white/40">Adversarial revisions</span>
                <span className="mono text-[11px] text-[var(--color-neon)]">{maxRevisions}</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={1}
                value={maxRevisions}
                onChange={(e) => setMaxRevisions(Number(e.target.value))}
                className="w-full accent-[var(--color-neon)]"
              />
              <p className="mono mt-1 text-[9px] leading-relaxed text-white/35">
                If the Critic finds MAJOR issues, the Analyst must revise and be re-reviewed — up
                to this many cycles.
              </p>
              <label className="mt-4 flex cursor-pointer items-start gap-2 border-t border-white/5 pt-3">
                <input
                  type="checkbox"
                  checked={webSearchEnabled}
                  onChange={(e) => setWebSearchEnabled(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-neon)]"
                />
                <span>
                  <span className="text-xs text-white">Web research (OrioSearch)</span>
                  <span className="mono mt-0.5 block text-[9px] leading-relaxed text-white/35">
                    Each Researcher searches per sub-question; cited URLs are machine-verified
                    against real results. Off = fully local, citations marked UNVERIFIED.
                  </span>
                </span>
              </label>
              <label
                className={`mt-3 flex items-start gap-2 border-t border-white/5 pt-3 ${
                  webSearchEnabled ? 'cursor-pointer' : 'opacity-40'
                }`}
              >
                <input
                  type="checkbox"
                  checked={deepVerify}
                  disabled={!webSearchEnabled}
                  onChange={(e) => setDeepVerify(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-neon)]"
                />
                <span>
                  <span className="text-xs text-white">Deep claim verification</span>
                  <span className="mono mt-0.5 block text-[9px] leading-relaxed text-white/35">
                    Fetches the REAL text of cited pages (OrioSearch /extract); a Verifier agent
                    judges each claim SUPPORTED / PARTIAL / NOT_FOUND against it. Slower, more
                    rigorous.
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>
      </div>

      {/* Workspace */}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5">
        {todos.length === 0 && !running && (
          <div className="mono mt-16 text-center text-xs text-white/30">
            Enter a research question and press Run. The Orchestrator decomposes it into
            sub-questions, then the agent team works through them.
          </div>
        )}

        {/* Plan: research question + sub-question checklist */}
        {(plan.raw || todos.length > 0) && (
          <div className="glass rounded-xl p-4">
            <div className="mono mb-2 flex items-center gap-2 text-[11px] text-[var(--color-neon)]">
              <span className="h-2 w-2 rounded-full" style={{ background: AGENT_META.orchestrator.dot }} />
              Orchestrator · Research plan
              {!plan.done && <span className="animate-pulse text-white/40">decomposing…</span>}
            </div>
            {question && (
              <p className="mb-3 text-[13px] text-white/75">
                <span className="mono mr-2 text-[9px] uppercase tracking-wider text-white/35">Question</span>
                {question}
              </p>
            )}
            {todos.length > 0 ? (
              <ul className="space-y-1.5">
                {todos.map((t) => {
                  const meta = AGENT_META[t.agent];
                  return (
                    <li key={t.id} className="flex items-center gap-2 text-[13px]">
                      <span className="w-4 shrink-0 text-center">
                        {t.status === 'done' ? (
                          <span className="text-emerald-300">✓</span>
                        ) : t.status === 'running' ? (
                          <span className="inline-block animate-pulse text-[var(--color-neon)]">◐</span>
                        ) : (
                          <span className="text-white/30">○</span>
                        )}
                      </span>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.dot }} />
                      <span className={`mono shrink-0 text-[10px] ${meta.accent}`}>{meta.name}</span>
                      <span
                        className={`truncate ${t.status === 'done' ? 'text-white/45' : 'text-white/80'}`}
                      >
                        {t.title}
                      </span>
                      <span className="mono ml-auto shrink-0 text-[9px] text-white/25">R{t.round}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <pre className="mono max-h-32 overflow-auto text-[11px] whitespace-pre-wrap text-white/45">
                {plan.raw}
              </pre>
            )}
          </div>
        )}

        {/* Activity by round */}
        {rounds.map((round) => {
          const roundTodos = todos.filter((t) => t.round === round);
          const review = reviews.find((r) => 2 + r.round === round);
          return (
            <div key={round} className="space-y-1.5">
              <div className="mono text-[10px] uppercase tracking-wider text-white/30">
                {round === 1
                  ? 'Round 1 · Isolated research + claim verification'
                  : round === 2
                    ? 'Round 2 · Synthesis'
                    : `Round ${round} · Review`}
              </div>
              {roundTodos.map((t) =>
                tasks[t.id] ? <DeepCell key={t.id} cell={tasks[t.id]} /> : null,
              )}
              {review && (
                <div className="mono rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-white/55">
                  <span style={{ color: AGENT_META.orchestrator.dot }}>◆ Orchestrator:</span>{' '}
                  <span className={review.decision === 'ACCEPT' ? 'text-emerald-300' : 'text-amber-300'}>
                    {review.decision}
                  </span>{' '}
                  — {review.reason}
                </div>
              )}
            </div>
          );
        })}

        {/* Virtual file system */}
        {files.length > 0 && <FileSystem files={files} />}

        {/* Final integrated report */}
        {final && (
          <div className="glass rounded-xl p-5">
            <div className="mono mb-3 flex items-center gap-2 text-[11px] text-[var(--color-neon)]">
              <span className="h-2 w-2 rounded-full" style={{ background: AGENT_META.orchestrator.dot }} />
              Orchestrator · Final integrated report
              {!final.done && <span className="animate-pulse text-white/40">integrating…</span>}
            </div>
            {final.raw ? (
              <Markdown>{final.raw}</Markdown>
            ) : (
              <span className="text-white/30">…</span>
            )}
          </div>
        )}

        {stopReason && (
          <div className="mono rounded-lg border border-[var(--color-neon)]/30 bg-[var(--color-neon)]/5 px-3 py-2 text-[11px] text-white/70">
            ✓ {stopReason}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function FileSystem({ files }: { files: VfsFile[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="glass rounded-xl p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="mono flex w-full items-center gap-2 text-[11px] text-[var(--color-teal)]"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        ▤ Agent file system · {files.length} file{files.length === 1 ? '' : 's'}
      </button>
      {open && (
        <ul className="mt-3 space-y-2">
          {files.map((f) => (
            <FileRow key={f.name} file={f} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileRow({ file }: { file: VfsFile }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-white/5 bg-white/[0.015]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/[0.03]"
      >
        <span className={`text-white/40 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="mono shrink-0 text-[11px] text-white/70">{file.name}</span>
        <span className="truncate text-[11px] text-white/35">{file.summary}</span>
      </button>
      {open && (
        <div className="border-t border-white/5 px-4 py-3">
          <Markdown>{file.content}</Markdown>
        </div>
      )}
    </li>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4">{children}</div>
  );
}
