
export type Role = 'system' | 'user' | 'assistant';

export interface AgentMessage {
  role: Role;
  content: string;
  kind?:
    | 'system'
    | 'summary'
    | 'history'
    | 'objective'
    | 'request'
    | 'tool_call'
    | 'tool_result'
    | 'supervisor';
}

export interface ToolCall {
  tool: string;
  raw: string;
  args: Record<string, unknown>;
}

export type StepStatus = 'running' | 'done' | 'error' | 'awaiting_approval' | 'denied' | 'skipped';

export interface AgentStep {
  id: string;
  round: number;
  tool: string;
  summary: string;
  args: Record<string, unknown>;
  status: StepStatus;
  approvalReason?: string;
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
  | 'context_pressure'
  | 'trimmed'
  | 'empty_response'
  | 'error';

export interface ContextUsage {
  used: number;
  budget: number;
}

export type AgentEvent =
  | { type: 'round_start'; round: number }
  | { type: 'text'; round: number; text: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'context'; usage: ContextUsage }
  | { type: 'notice'; kind: AgentNoticeKind; message: string };

export type LlmFn = (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string>;
