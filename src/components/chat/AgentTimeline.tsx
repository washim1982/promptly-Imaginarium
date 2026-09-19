import { useState } from 'react';
import { useLlm } from '../../state/LlmContext';
import type { AgentView } from '../../lib/agent/session';
import type { AgentStep } from '../../lib/agent/types';
import Markdown from './Markdown';

const STATUS: Record<AgentStep['status'], { label: string; cls: string }> = {
  running: { label: 'running', cls: 'text-amber-300 border-amber-400/30' },
  done: { label: 'done', cls: 'text-emerald-300 border-emerald-400/30' },
  error: { label: 'failed', cls: 'text-red-300 border-red-400/30' },
  awaiting_approval: { label: 'needs approval', cls: 'text-[var(--color-neon)] border-[var(--color-neon)]/40' },
  denied: { label: 'declined', cls: 'text-white/45 border-white/15' },
  skipped: { label: 'not run', cls: 'text-white/45 border-white/15' },
};

const ICON: Record<string, string> = {
  list_dir: '▣',
  read_file: '▤',
  search_files: '⌕',
  write_file: '✎',
  run_command: '›_',
  web_search: '◎',
  fetch_url: '⇣',
};

/** An agent reply: prose, tool steps and supervisor notices, in order. */
export default function AgentTimeline({ view, streaming }: { view: AgentView; streaming: boolean }) {
  const { send, isGenerating } = useLlm();
  const lastTextIdx = view.timeline.map((t) => t.kind).lastIndexOf('text');

  return (
    <div className="space-y-2">
      {view.timeline.map((item, i) => {
        if (item.kind === 'text') {
          return (
            <div key={`t${item.round}`}>
              <Markdown>{item.text}</Markdown>
              {streaming && i === lastTextIdx && (
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--color-neon)] align-middle" />
              )}
            </div>
          );
        }
        if (item.kind === 'step') {
          const step = view.steps[item.id];
          return step ? <StepCard key={item.id} step={step} /> : null;
        }
        return (
          <p key={`n${i}`} className="mono flex items-start gap-2 text-[10px] leading-relaxed text-[var(--color-teal)]/80">
            <span>◆</span>
            <span>{item.message}</span>
          </p>
        );
      })}

      {view.running && !view.timeline.length && (
        <span className="mono inline-flex items-center gap-2 text-[11px] text-white/45">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-neon)]" />
          Thinking…
        </span>
      )}

      {view.stopped && <p className="mono text-[10px] text-white/40">Stopped.</p>}

      {view.exhausted && !view.running && (
        <button
          onClick={() => void send('Continue from where you stopped.')}
          disabled={isGenerating}
          className="mono rounded-md border border-[var(--color-neon)]/40 px-3 py-1.5 text-[10px] text-white transition hover:bg-[var(--color-neon)]/15 disabled:opacity-40"
        >
          ↻ Continue
        </button>
      )}
    </div>
  );
}

function StepCard({ step }: { step: AgentStep }) {
  const { resolveApproval } = useLlm();
  const [open, setOpen] = useState(false);
  const status = STATUS[step.status];
  const awaiting = step.status === 'awaiting_approval';
  // For approvals, show exactly what will run.
  const detail =
    step.tool === 'write_file'
      ? String(step.args.content ?? '')
      : step.tool === 'run_command'
        ? String(step.args.command ?? '')
        : '';

  return (
    <div
      className={`glass rounded-xl border px-3 py-2 ${
        awaiting ? 'neon-glow border-[var(--color-neon)]/40' : 'border-white/10'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!step.output && !detail}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="mono w-5 shrink-0 text-center text-[11px] text-[var(--color-neon)]">
          {ICON[step.tool] ?? '•'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-white/85" title={step.summary}>
          {step.summary}
        </span>
        {step.status === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />}
        <span className={`mono shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${status.cls}`}>{status.label}</span>
        {(step.output || detail) && <span className="mono text-[10px] text-white/30">{open ? '▾' : '▸'}</span>}
      </button>

      {awaiting && (
        <div className="mt-2 space-y-2">
          <p className="text-[12px] text-white/60">{step.approvalReason}</p>
          {detail && (
            <pre className="max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-[var(--font-mono)] text-[11.5px] text-white/80">
              {detail}
            </pre>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => resolveApproval(step.id, true)}
              className="neon-glow rounded-lg bg-[var(--color-neon)] px-3 py-1.5 text-[12px] font-semibold text-black transition hover:brightness-110"
            >
              Approve
            </button>
            <button
              onClick={() => resolveApproval(step.id, false)}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {open && !awaiting && (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-2 font-[var(--font-mono)] text-[11.5px] leading-relaxed text-white/70">
          {detail && step.status !== 'done' ? `${detail}\n\n` : ''}
          {step.output}
        </pre>
      )}
    </div>
  );
}
