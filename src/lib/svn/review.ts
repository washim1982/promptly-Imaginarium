
import type { EngineConfig } from '../engine';
import type { ModelEntry } from '../models';

export const REVIEW_MODEL_FILE = 'gemma-4-E4B-it-web.litertlm';
export const REVIEW_MODEL_LABEL = 'gemma-4-E4B-it-web';

export function findReviewModel(models: ModelEntry[]): ModelEntry | undefined {
  const byName = (re: RegExp) => models.find((m) => re.test(m.name));
  return (
    models.find((m) => m.name.toLowerCase() === REVIEW_MODEL_FILE.toLowerCase()) ??
    byName(/gemma-4-e4b.*web.*\.litertlm$/i) ??
    byName(/e4b.*\.litertlm$/i)
  );
}

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

export function contextBudget(settings: Pick<EngineConfig, 'maxNumTokens' | 'maxOutputTokens'>): number {
  const tokensForContext = settings.maxNumTokens - settings.maxOutputTokens - 800;
  return Math.max(4_000, Math.min(48_000, Math.floor(tokensForContext * 3)));
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
}
