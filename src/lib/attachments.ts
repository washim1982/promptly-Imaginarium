// Things the user attaches to a chat message from the sidebar: an email, a
// Google Drive file, or a workspace file.
//
// Their text goes to the local model inside the same untrusted-data wrapper the
// agent uses for tool output — an email is exactly the kind of content that
// carries prompt-injection ("ignore your instructions and…"). Nothing here
// leaves the machine: the model runs locally.

import { untrustedToolMessage } from './agent/context';

export type AttachmentKind = 'email' | 'drive' | 'file';

export interface AttachmentMeta {
  kind: AttachmentKind;
  title: string;
  /** Sender, file type, path… — shown under the title. */
  subtitle?: string;
  /** True when the text was cut to fit the model's context window. */
  truncated?: boolean;
}

export interface ChatAttachment extends AttachmentMeta {
  id: string;
  text: string;
}

export const KIND_LABEL: Record<AttachmentKind, string> = {
  email: 'Email',
  drive: 'Google Drive file',
  file: 'Workspace file',
};

/** Characters per token, the estimate the agent's context code uses. */
const CHARS_PER_TOKEN = 1 / 0.3;

/**
 * How many characters of attachments fit in one message: at most 60% of the
 * input budget, leaving room for the history, the question and the reply.
 */
export function attachmentCharBudget(inputTokenBudget: number): number {
  return Math.max(2_000, Math.floor(inputTokenBudget * 0.6 * CHARS_PER_TOKEN));
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  // Keep the start and the end: an email's sign-off or a file's tail often matters.
  const head = Math.floor(limit * 0.8);
  const tail = limit - head;
  return {
    text: `${text.slice(0, head)}\n\n[… ${text.length - limit} characters omitted to fit the model's context …]\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

/**
 * The text the model actually receives: each attachment wrapped as untrusted
 * source data, then the user's own words. The budget is shared equally.
 */
export function buildPromptWithAttachments(
  prompt: string,
  attachments: ChatAttachment[],
  charBudget: number,
): { modelText: string; meta: AttachmentMeta[] } {
  if (!attachments.length) return { modelText: prompt, meta: [] };
  const each = Math.max(500, Math.floor(charBudget / attachments.length));
  const meta: AttachmentMeta[] = [];
  const blocks = attachments.map((a) => {
    const { text, truncated } = clip(a.text.trim() || '(empty)', each);
    meta.push({ kind: a.kind, title: a.title, subtitle: a.subtitle, truncated: truncated || a.truncated });
    const label = `${KIND_LABEL[a.kind]} — ${a.title}${a.subtitle ? ` (${a.subtitle})` : ''}`;
    return untrustedToolMessage(label, text).content;
  });
  const noun = attachments.length === 1 ? 'an item' : `${attachments.length} items`;
  return {
    modelText: `The user attached ${noun} to this message.\n\n${blocks.join('\n\n')}\n\nThe user's message:\n${prompt}`,
    meta,
  };
}
