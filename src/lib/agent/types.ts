// Shared shapes for the agent loop (ported from Odysseus src/agent_loop.py).

export type Role = 'system' | 'user' | 'assistant';

/**
 * One message in the agent's managed context. Unlike the chat path — where the
 * LiteRT-LM Conversation keeps history internally — the agent owns this list
 * and rebuilds the model's context from it every round, which is what makes
 * trimming and compaction possible.
 */
export interface AgentMessage {
  role: Role;
  content: string;
  /** What the message is, so context management knows what it may drop. */
  kind?:
    | 'system' // the agent system prompt (never dropped)
    | 'summary' // a compaction summary
    | 'history' // a prior chat turn (user text or assistant final answer)
    | 'request' // the current user request
    | 'tool_call' // assistant round that contained tool blocks
    | 'tool_result' // untrusted tool output fed back to the model
    | 'supervisor'; // loop-breaker / intent nudges / force-answer instructions
}

export interface ToolCall {
  tool: string;
  /** Raw block body as the model wrote it. */
  raw: string;
  args: Record<string, unknown>;
}

export type StepStatus = 'running' | 'done' | 'error' | 'awaiting_approval' | 'denied' | 'skipped';

export interface AgentStep {
  id: string;
  round: number;
  tool: string;
  /** Short human-readable description of the call, for the step card. */
  summary: string;
  args: Record<string, unknown>;
  status: StepStatus;
  /** Why approval is needed, when status is awaiting_approval. */
  approvalReason?: string;
  /** Tool output (capped) — what the model saw. */
  output?: string;
}

export type AgentNoticeKind =
  | 'loop_breaker'
  | 'intent_nudge'
  | 'intent_nudge_exhausted'
  | 'force_answer'
  | 'grace_synthesis'
  | 'budget_exceeded'
  | 'rounds_exhausted'
  | 'compacted'
  | 'trimmed'
  | 'empty_response'
  | 'error';

export interface ContextUsage {
  /** Estimated tokens in the request actually sent this round. */
  used: number;
  /** Input budget for the model's window. */
  budget: number;
}

export type AgentEvent =
  | { type: 'round_start'; round: number }
  | { type: 'text'; round: number; text: string } // visible prose for this round, cumulative
  | { type: 'step'; step: AgentStep }
  | { type: 'context'; usage: ContextUsage }
  | { type: 'notice'; kind: AgentNoticeKind; message: string };

/** Streams model text for a managed message list. */
export type LlmFn = (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string>;
