// Glue between the agent loop and the chat: building each turn's context from
// the transcript, folding loop events into what a chat message displays, and
// what of it is persisted.

import { SUMMARY_PREFIX } from './context';
import type { AgentEvent, AgentMessage, AgentNoticeKind, AgentStep, ContextUsage } from './types';

export type TimelineItem =
  | { kind: 'text'; round: number; text: string }
  | { kind: 'step'; id: string }
  | { kind: 'notice'; notice: AgentNoticeKind; message: string };

/** What an agent reply shows: prose and tool steps in the order they happened. */
export interface AgentView {
  timeline: TimelineItem[];
  steps: Record<string, AgentStep>;
  usage?: ContextUsage;
  running: boolean;
  exhausted?: boolean;
  stopped?: boolean;
}

export const emptyAgentView = (): AgentView => ({ timeline: [], steps: {}, running: true });

/** Pure reducer: fold one loop event into the message's view. */
export function applyAgentEvent(view: AgentView, event: AgentEvent): AgentView {
  switch (event.type) {
    case 'round_start':
      return view;
    case 'context':
      return { ...view, usage: event.usage };
    case 'text': {
      const idx = view.timeline.findIndex((t) => t.kind === 'text' && t.round === event.round);
      if (idx >= 0) {
        const timeline = [...view.timeline];
        timeline[idx] = { kind: 'text', round: event.round, text: event.text };
        return { ...view, timeline };
      }
      if (!event.text) return view;
      return { ...view, timeline: [...view.timeline, { kind: 'text', round: event.round, text: event.text }] };
    }
    case 'step': {
      const steps = { ...view.steps, [event.step.id]: event.step };
      const known = view.timeline.some((t) => t.kind === 'step' && t.id === event.step.id);
      return { ...view, steps, timeline: known ? view.timeline : [...view.timeline, { kind: 'step', id: event.step.id }] };
    }
    case 'notice': {
      // "Trimmed" can fire every round of a long turn; once is informative.
      if (event.kind === 'trimmed' && view.timeline.some((t) => t.kind === 'notice' && t.notice === 'trimmed')) {
        return view;
      }
      return {
        ...view,
        timeline: [...view.timeline, { kind: 'notice', notice: event.kind, message: event.message }],
      };
    }
  }
}

/** Persisted compaction of earlier chat turns, carried across agent turns. */
export interface AgentContextState {
  /** Summaries of compacted turns, oldest first. */
  summaries: string[];
  /** How many leading transcript messages the summaries replace. */
  covered: number;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * The managed context for one agent turn:
 *   [system prompt, earlier summaries, prior turns not yet summarised, request]
 * Prior assistant turns contribute their final prose, not their raw tool
 * traffic — the same thing the transcript shows.
 */
export function buildTurnMessages(
  systemPrompt: string,
  transcript: HistoryMessage[],
  request: string,
  saved: AgentContextState | undefined,
): { messages: AgentMessage[]; historyIndex: number[] } {
  const messages: AgentMessage[] = [{ role: 'system', kind: 'system', content: systemPrompt }];
  for (const s of saved?.summaries ?? []) {
    messages.push({ role: 'system', kind: 'summary', content: `${SUMMARY_PREFIX}\n${s}` });
  }
  // Which transcript index each 'history' message came from, so a compaction
  // reported as "k history messages summarised" maps back to the transcript.
  const historyIndex: number[] = [];
  const start = Math.min(saved?.covered ?? 0, transcript.length);
  transcript.forEach((m, i) => {
    if (i < start || !m.text.trim()) return;
    messages.push({ role: m.role, kind: 'history', content: m.text });
    historyIndex.push(i);
  });
  messages.push({ role: 'user', kind: 'request', content: request });
  return { messages, historyIndex };
}

/** Fold a compaction reported by the loop into the persisted state. */
export function nextContextState(
  saved: AgentContextState | undefined,
  compaction: { summary: string; historySummarized: number } | undefined,
  historyIndex: number[],
): AgentContextState | undefined {
  if (!compaction || compaction.historySummarized <= 0) return saved;
  const lastCovered = historyIndex[compaction.historySummarized - 1];
  if (lastCovered === undefined) return saved;
  return {
    summaries: [...(saved?.summaries ?? []), compaction.summary].slice(-3),
    covered: lastCovered + 1,
  };
}

/** Steps as stored: outputs capped so IndexedDB doesn't balloon. */
export function persistableView(view: AgentView): Omit<AgentView, 'running' | 'usage'> {
  const steps: Record<string, AgentStep> = {};
  for (const [id, s] of Object.entries(view.steps)) {
    steps[id] = {
      ...s,
      // An approval left hanging when the app closed is, in effect, declined.
      status: s.status === 'awaiting_approval' || s.status === 'running' ? 'skipped' : s.status,
      output: s.output && s.output.length > 2000 ? `${s.output.slice(0, 2000)}\n… (truncated)` : s.output,
    };
  }
  return { timeline: view.timeline, steps, exhausted: view.exhausted, stopped: view.stopped };
}
