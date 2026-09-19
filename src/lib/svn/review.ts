// AI code review for the SVN Studio tab.
//
// SVN Studio sent review requests from its Express server to an OpenAI-compatible
// endpoint (llama.cpp / Ollama / LM Studio). Here there is no server to run: the
// main process assembles the context, and the review runs on the in-app LiteRT-LM
// engine using gemma-4-E4B-it-web — the model this feature is pinned to.

import type { EngineConfig } from '../engine';
import type { ModelEntry } from '../models';

/** The model SVN reviews run on. */
export const REVIEW_MODEL_FILE = 'gemma-4-E4B-it-web.litertlm';
export const REVIEW_MODEL_LABEL = 'gemma-4-E4B-it-web';

/**
 * Find the review model in the library. Exact filename first; then any E4B web
 * build, so a renamed download or a differently-cased filename still matches.
 */
export function findReviewModel(models: ModelEntry[]): ModelEntry | undefined {
  const byName = (re: RegExp) => models.find((m) => re.test(m.name));
  return (
    models.find((m) => m.name.toLowerCase() === REVIEW_MODEL_FILE.toLowerCase()) ??
    byName(/gemma-4-e4b.*web.*\.litertlm$/i) ??
    byName(/e4b.*\.litertlm$/i)
  );
}

// Unchanged from SVN Studio's aiService.ts — it was written for small local
// models and asks for exactly the structure a reviewer wants.
export const REVIEW_SYSTEM_PROMPT = `You are a senior software engineer reviewing code from a Subversion working copy.
You will receive source files and/or unified diffs as context, followed by the user's request.
If the user asks a specific question, answer it directly using the provided context.
If the request is a general review (or empty), report, grouped by file:
- Bugs and logic errors
- Security issues (injection, secrets, unsafe input handling)
- Risky or breaking changes
- Concrete improvement suggestions
Be specific and concise; quote the relevant line when useful. If the code looks fine, say so briefly.
For a general review, finish with a one-line verdict: "Looks good", "Minor fixes suggested", or "Needs changes".`;

export const DEFAULT_REVIEW_REQUEST = 'Review this code.';

export function buildReviewPrompt(context: string, question: string): string {
  return `Context:\n\n${context}\nRequest: ${question.trim() || DEFAULT_REVIEW_REQUEST}`;
}

/**
 * How many characters of code the model can take.
 *
 * SVN Studio hard-coded 12,000 chars for an 8k llama.cpp context. Here the window
 * is the user's own "Context window" setting, so derive the budget from it: leave
 * room for the reply cap and the prompt scaffolding, and assume ~3 chars/token,
 * which is conservative for source code.
 */
export function contextBudget(settings: Pick<EngineConfig, 'maxNumTokens' | 'maxOutputTokens'>): number {
  const tokensForContext = settings.maxNumTokens - settings.maxOutputTokens - 800;
  return Math.max(4_000, Math.min(48_000, Math.floor(tokensForContext * 3)));
}

/** Reasoning models inline chain-of-thought in <think> tags; show only the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
}
