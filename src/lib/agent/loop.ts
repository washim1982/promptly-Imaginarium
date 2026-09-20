// The agent loop — a port of Odysseus's stream_agent_loop (src/agent_loop.py).
//
// Each round: manage the context (compact, then trim), stream one model
// response, parse tool blocks out of it, run them (asking the user first for
// anything effectful), feed the results back as untrusted data, and go again.
// The model ends the turn by answering without a tool call.
//
// What's kept from Odysseus, by name:
//   - round cap with a "Continue" affordance when it's hit mid-task
//   - tool-call budget per turn
//   - loop-breaker: a repeated call with no new text, or one identical call
//     fired too often, forces a single tool-free "answer or say you're
//     blocked" round
//   - intent-without-action supervisor: "Let me check the logs" with no call
//     gets a nudge (capped at 2)
//   - grace synthesis: if the forced round still writes nothing, one plain call
//     to write the answer from what was gathered
//   - empty-response fallback
//   - tool output wrapped as untrusted data
// What's dropped: provider routing/fallbacks, native function calling, the
// email/calendar/cookbook domain logic, plan mode and the verifier sub-agent.
//
// Everything that touches the model, tools or UI is injected, so the loop runs
// unchanged under a scripted fake model in tests.

import {
  estimateTokens,
  maybeCompact,
  normalizeTurns,
  toolOutputCharCap,
  trimForContext,
  truncateOutput,
  untrustedToolMessage,
} from './context';
import { callSignature, parseToolBlocks, visibleText } from './protocol';
import type { AgentEvent, AgentMessage, AgentNoticeKind, AgentStep, LlmFn, ToolCall } from './types';

export interface ToolRuntime {
  tags: string[];
  primaryArgs: Record<string, string | undefined>;
  describe(call: ToolCall): string;
  /** Non-null when the call must be approved by the user first — the reason why. */
  approvalReason(call: ToolCall): string | null;
  run(call: ToolCall, signal: AbortSignal): Promise<{ ok: boolean; output: string }>;
}

export interface AgentLoopOptions {
  /** [system prompt, ...prior chat turns, current request]. */
  messages: AgentMessage[];
  llm: LlmFn;
  tools: ToolRuntime;
  /** Input-token budget for one request. */
  budget: number;
  maxRounds?: number;
  maxToolCalls?: number;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /** Resolve true to run an effectful call, false to decline it. */
  requestApproval: (step: AgentStep) => Promise<boolean>;
  newId?: () => string;
}

export interface AgentLoopResult {
  /** Final prose from every round, tool blocks stripped — what gets saved. */
  text: string;
  rounds: number;
  toolCalls: number;
  /** Ran out of rounds while still working: offer Continue. */
  exhausted: boolean;
  stopped: boolean;
  /** Set if this turn compacted prior chat history, for persisting. */
  compaction?: { summary: string; historySummarized: number };
}

// Odysseus uses 50 rounds and a runaway threshold of 15 identical calls. Every
// round here re-prefills the whole context on a local GPU and the window is a
// few thousand tokens, so both are scaled down.
export const DEFAULT_MAX_ROUNDS = 12;
export const DEFAULT_MAX_TOOL_CALLS = 24;
const RUNAWAY_THRESHOLD = 5;
const STUCK_ROUNDS_LIMIT = 3;
const RECENT_SIGNATURES = 6;
const MAX_INTENT_NUDGES = 2;

// Odysseus's "I said I would, then didn't" detector: an announced action with
// an action verb, so harmless text like "let me know" never triggers it.
const INTENT_RE = new RegExp(
  "(?:^|\\n)\\s*(?:let me|i'?ll|i will|i need to|we need to|need to|i should|we should|" +
    "i must|we must|going to|let's)\\s+(?:tail|check|investigate|look at|see|read|fetch|" +
    'inspect|verify|diagnose|examine|debug|capture|grab|pull|view|run|call|trigger|launch|' +
    'start|stop|kill|restart|list|search|find|query|hit|ping|test|use|perform|do|open|write|create)' +
    '\\b[^.\\n]{0,140}',
  'i',
);

const SUPERVISOR_LOOP =
  "You're repeating tool calls without converging. STOP calling tools and end the " +
  'turn one of two ways: (a) write your best final answer NOW from the information ' +
  "already gathered, or (b) if you're genuinely blocked, say plainly what's blocking " +
  'you in a sentence or two.';

const SUPERVISOR_BUDGET =
  'The tool-call budget for this turn is used up. Do not call any more tools. Write ' +
  'your final answer now from the information already gathered, and say briefly what ' +
  'is still missing, if anything.';

const GRACE_SYNTHESIS =
  'Using ONLY the information already gathered above, write the final answer for the ' +
  'user now. Do NOT call any tools, do NOT explain your reasoning — output the finished ' +
  "response directly. If some data couldn't be fetched, work with what you have and " +
  "note what's missing in one short line.";

const intentNudge = (phrase: string) =>
  `You just wrote: "${phrase}" — but ended the turn without making the actual tool ` +
  'call. DO IT NOW: write the tool block this turn. If you decided not to do it after ' +
  'all, say so plainly in one sentence instead of restating the plan.';

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    llm,
    tools,
    budget,
    signal,
    onEvent,
    requestApproval,
    maxRounds = DEFAULT_MAX_ROUNDS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
  } = opts;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const outputCap = toolOutputCharCap(budget);

  let messages = [...opts.messages];
  const prose: string[] = [];
  const recentSigs: string[] = [];
  const callFreq = new Map<string, number>();
  let stuckRounds = 0;
  let nudges = 0;
  let forceAnswer = false;
  let toolCalls = 0;
  let finished = false;
  let compaction: AgentLoopResult['compaction'];
  let round = 0;

  const summarize = (prompt: AgentMessage[]) => collect(llm(normalizeTurns(prompt), signal));
  const notice = (kind: AgentNoticeKind, message: string) => onEvent({ type: 'notice', kind, message });
  // Repeated compaction inside one turn means the work doesn't fit the window:
  // the model keeps losing what it just read and starts over. Say so once,
  // rather than letting it grind through its round budget.
  let compactions = 0;

  for (round = 1; round <= maxRounds; round++) {
    if (signal.aborted) break;
    onEvent({ type: 'round_start', round });

    // ── Context management (Odysseus: maybe_compact, then trim_for_context) ──
    const compacted = await maybeCompact(messages, budget, summarize);
    if (signal.aborted) break;
    if (compacted.compacted) {
      messages = compacted.messages;
      if (compacted.historySummarized > 0 && compacted.summary) {
        compaction = { summary: compacted.summary, historySummarized: compacted.historySummarized };
      }
      notice('compacted', `Context compacted: ${compacted.summarized} earlier messages summarized.`);
      if (++compactions === 2) {
        notice(
          'context_pressure',
          'This task needs more context than the model has. Raise "Context window" in Settings (and reload the model), ' +
            'or ask for it in smaller steps — otherwise earlier findings are summarised away as it works.',
        );
      }
    }
    const request = trimForContext(messages, budget);
    if (request.length < messages.length) {
      notice('trimmed', `Context trimmed to fit: ${messages.length - request.length} older messages left out of this request.`);
    }
    onEvent({ type: 'context', usage: { used: estimateTokens(request), budget } });

    // ── One model response ──
    let raw = '';
    for await (const chunk of llm(normalizeTurns(request), signal)) {
      raw += chunk;
      onEvent({ type: 'text', round, text: visibleText(raw, tools.tags, true) });
    }
    if (signal.aborted) break;
    const text = visibleText(raw, tools.tags, false);
    onEvent({ type: 'text', round, text });
    const calls = forceAnswer ? [] : parseToolBlocks(raw, tools.tags, tools.primaryArgs);

    // ── Forced answer round: tools were refused; take the prose or salvage ──
    if (forceAnswer) {
      let answer = text;
      if (!answer) {
        const synth = await collect(
          llm(
            normalizeTurns([
              ...trimForContext(messages, budget),
              { role: 'user', kind: 'supervisor', content: GRACE_SYNTHESIS },
            ]),
            signal,
          ),
        ).catch(() => '');
        answer = visibleText(synth, tools.tags, false);
        if (answer) notice('grace_synthesis', 'Wrote the final answer from the results already gathered.');
      }
      if (!answer) {
        answer =
          "I wasn't able to finish this: I kept repeating the same steps without making " +
          'progress. Try rephrasing the request or breaking it into smaller steps.';
      }
      onEvent({ type: 'text', round, text: answer });
      prose.push(answer);
      finished = true;
      break;
    }

    // ── No tool call: the model is done — unless it promised an action ──
    if (calls.length === 0) {
      const promise = INTENT_RE.exec(text);
      const looksLikePromise = promise !== null && text.length < 400 && !text.includes('```');
      if (looksLikePromise && nudges < MAX_INTENT_NUDGES) {
        nudges += 1;
        const phrase = promise![0].trim();
        // Plain prose — no tool call in it, so not kind 'tool_call' (that kind
        // pairs with a following tool_result when trimming).
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', kind: 'supervisor', content: intentNudge(phrase) });
        notice('intent_nudge', `The model said "${phrase}" without running a tool — nudging it to act.`);
        if (text) prose.push(text);
        continue;
      }
      if (looksLikePromise) {
        notice(
          'intent_nudge_exhausted',
          'The agent stopped because it repeatedly announced an action without making the tool call.',
        );
      }
      if (text) prose.push(text);
      finished = true;
      break;
    }

    // ── Loop-breaker ──
    const sig = calls.map(callSignature).sort().join('|');
    const isRepeat = recentSigs.includes(sig);
    recentSigs.push(sig);
    if (recentSigs.length > RECENT_SIGNATURES) recentSigs.shift();
    for (const c of calls) {
      const s = callSignature(c);
      callFreq.set(s, (callFreq.get(s) ?? 0) + 1);
    }
    // A round is useless only if it repeats a recent call AND says nothing new.
    stuckRounds = isRepeat && !text ? stuckRounds + 1 : 0;
    const runaway = [...callFreq.entries()].find(([, n]) => n >= RUNAWAY_THRESHOLD)?.[0];
    if (stuckRounds >= STUCK_ROUNDS_LIMIT || runaway) {
      const detail = runaway
        ? `calling ${runaway.split(':')[0]} with identical arguments over and over`
        : 'repeating the same tool calls without new progress';
      notice('loop_breaker', `Loop-breaker: the agent was ${detail}, so it's being asked for its best final answer.`);
      messages.push({ role: 'user', kind: 'supervisor', content: SUPERVISOR_LOOP });
      forceAnswer = true;
      if (text) prose.push(text);
      continue;
    }

    // ── Run the tools ──
    const results: string[] = [];
    let budgetHit = false;
    for (const call of calls) {
      if (signal.aborted) break;
      if (toolCalls >= maxToolCalls) {
        budgetHit = true;
        break;
      }
      toolCalls += 1;
      const step: AgentStep = {
        id: newId(),
        round,
        tool: call.tool,
        summary: tools.describe(call),
        args: call.args,
        status: 'running',
      };
      const reason = tools.approvalReason(call);
      if (reason) {
        step.status = 'awaiting_approval';
        step.approvalReason = reason;
        onEvent({ type: 'step', step: { ...step } });
        const approved = await requestApproval({ ...step });
        if (signal.aborted) break;
        if (!approved) {
          step.status = 'denied';
          step.output = 'Declined by the user.';
          onEvent({ type: 'step', step: { ...step } });
          results.push(
            `### ${step.summary}\nThe user declined this action. Do not retry it; continue without it or ask the user how to proceed.`,
          );
          continue;
        }
        step.status = 'running';
      }
      onEvent({ type: 'step', step: { ...step } });

      let result: { ok: boolean; output: string };
      try {
        result = await tools.run(call, signal);
      } catch (err) {
        result = { ok: false, output: `Error: ${(err as Error).message}` };
      }
      step.status = result.ok ? 'done' : 'error';
      step.output = truncateOutput(result.output || '(no output)', outputCap);
      onEvent({ type: 'step', step: { ...step } });
      results.push(`### ${step.summary}${result.ok ? '' : ' (FAILED)'}\n${step.output}`);
    }
    if (signal.aborted) break;

    // Feed the round back: the model's own call, then the results as data.
    messages.push({ role: 'assistant', kind: 'tool_call', content: raw });
    if (results.length) messages.push(untrustedToolMessage('tool execution results', results.join('\n\n')));
    if (text) prose.push(text);

    if (budgetHit) {
      notice('budget_exceeded', `Tool-call budget reached (${maxToolCalls} calls) — asking for a final answer.`);
      messages.push({ role: 'user', kind: 'supervisor', content: SUPERVISOR_BUDGET });
      forceAnswer = true;
    }
  }

  const stopped = signal.aborted;
  // The for-loop ran every round without a break: cut off mid-task.
  const exhausted = !finished && !stopped && round > maxRounds;
  if (exhausted) {
    notice('rounds_exhausted', `Reached the ${maxRounds}-round limit while still working.`);
  }

  let text = prose.join('\n\n').trim();
  if (!text && toolCalls === 0 && !stopped) {
    text = 'The model returned an empty response. Please try again or switch to a different model.';
    notice('empty_response', text);
  }
  return { text, rounds: Math.min(round, maxRounds), toolCalls, exhausted, stopped, compaction };
}
