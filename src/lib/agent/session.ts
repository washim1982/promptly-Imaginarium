
import { SUMMARY_PREFIX } from './context';
import type { AgentEvent, AgentMessage, AgentNoticeKind, AgentStep, ContextUsage } from './types';

export type TimelineItem =
  | { kind: 'text'; round: number; text: string }
  | { kind: 'step'; id: string }
  | { kind: 'notice'; notice: AgentNoticeKind; message: string };

export interface AgentView {
  timeline: TimelineItem[];
  steps: Record<string, AgentStep>;
  usage?: ContextUsage;
  running: boolean;
  exhausted?: boolean;
  stopped?: boolean;
}

export const emptyAgentView = (): AgentView => ({ timeline: [], steps: {}, running: true });

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

export interface AgentContextState {
  summaries: string[];
  covered: number;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

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
  const historyIndex: number[] = [];
  const start = Math.min(saved?.covered ?? 0, transcript.length);
  transcript.forEach((m, i) => {
    if (i < start || !m.text.trim()) return;
    messages.push({ role: m.role, kind: 'history', content: m.text });
    historyIndex.push(i);
  });
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'history' && messages[i].role === 'user') {
      messages[i] = { ...messages[i], kind: 'objective' };
      break;
    }
  }
  messages.push({ role: 'user', kind: 'request', content: request });
  return { messages, historyIndex };
}

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

export function persistableView(view: AgentView): Omit<AgentView, 'running' | 'usage'> {
  const steps: Record<string, AgentStep> = {};
  for (const [id, s] of Object.entries(view.steps)) {
    steps[id] = {
      ...s,
      status: s.status === 'awaiting_approval' || s.status === 'running' ? 'skipped' : s.status,
      output: s.output && s.output.length > 2000 ? `${s.output.slice(0, 2000)}\n… (truncated)` : s.output,
    };
  }
  return { timeline: view.timeline, steps, exhausted: view.exhausted, stopped: view.stopped };
}
