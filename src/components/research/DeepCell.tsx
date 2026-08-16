import { useState } from 'react';
import { AGENT_META, type SubAgentId } from '../../lib/deepAgents';
import Markdown from '../chat/Markdown';

export interface TaskCellData {
  todoId: string;
  agent: SubAgentId;
  title: string;
  round: number;
  status: 'streaming' | 'done';
  raw: string;
  summary?: string;
  file?: string;
  search?: string;
  // Mechanical citation check result (researchers only).
  citations?: { verified: number; unverified: number };
  // Content-entailment result (verifier only): claims vs. real page text.
  claims?: { supported: number; partial: number; notFound: number };
}

function clean(raw: string): string {
  // Strip the coordination markers so the body reads as plain Markdown.
  const notes = raw.split('@@NOTES@@')[1];
  return (notes ?? raw).replace(/@@SUMMARY@@|@@NOTES@@/g, '').trim();
}

export default function DeepCell({ cell }: { cell: TaskCellData }) {
  const [open, setOpen] = useState(false);
  const meta = AGENT_META[cell.agent];
  const md = clean(cell.raw);

  return (
    <div className="overflow-hidden rounded-md border border-white/5 bg-white/[0.015]">
      <div className="group flex items-center gap-2 px-2 py-1.5 hover:bg-white/[0.03]">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className={`text-white/40 transition-transform ${open ? 'rotate-90' : ''}`}>
            ▸
          </span>
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.dot }} />
          <span className={`mono shrink-0 text-[12px] ${meta.accent}`}>{meta.name}</span>
          <span className="truncate text-[12px] text-white/55">{cell.title}</span>
          {cell.status === 'streaming' && (
            <span className="mono ml-auto shrink-0 animate-pulse text-[10px] text-white/40">
              {cell.search ?? 'working…'}
            </span>
          )}
          {cell.status === 'done' && (
            <span className="mono ml-auto flex shrink-0 items-center gap-2 text-[9px]">
              {cell.citations && (
                <span
                  title="Cited URLs machine-checked against real search results"
                  className={
                    cell.citations.unverified > 0
                      ? 'rounded border border-amber-400/30 px-1.5 py-0.5 text-amber-300'
                      : 'rounded border border-emerald-400/30 px-1.5 py-0.5 text-emerald-300'
                  }
                >
                  ✓{cell.citations.verified}
                  {cell.citations.unverified > 0 && ` ⚠${cell.citations.unverified}`} cites
                </span>
              )}
              {cell.claims && (
                <span
                  title="Claims judged against machine-fetched page content"
                  className={
                    cell.claims.notFound > 0
                      ? 'rounded border border-amber-400/30 px-1.5 py-0.5 text-amber-300'
                      : 'rounded border border-emerald-400/30 px-1.5 py-0.5 text-emerald-300'
                  }
                >
                  ✓{cell.claims.supported}
                  {cell.claims.partial > 0 && ` ~${cell.claims.partial}`}
                  {cell.claims.notFound > 0 && ` ✗${cell.claims.notFound}`} claims
                </span>
              )}
              {cell.file && <span className="text-white/25">▣ {cell.file}</span>}
            </span>
          )}
        </button>
      </div>

      <div
        className={`grid transition-all duration-300 ease-out ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 border-t border-white/5 px-4 py-3">
            {cell.search && (
              <div className="mono text-[10px] text-[var(--color-teal)]">{cell.search}</div>
            )}
            {cell.summary && (
              <div>
                <div className="mono mb-1 text-[10px] uppercase tracking-wider text-white/35">
                  Summary
                </div>
                <p className="text-sm text-white/75">{cell.summary}</p>
              </div>
            )}
            <div>
              <div className="mono mb-1 text-[10px] uppercase tracking-wider text-white/35">
                Notes {cell.file ? `→ ${cell.file}` : ''}
              </div>
              {md ? <Markdown>{md}</Markdown> : <span className="text-white/30">…</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
