
import { untrustedToolMessage } from './agent/context';

export type AttachmentKind = 'email' | 'drive' | 'file';

export interface AttachmentMeta {
  kind: AttachmentKind;
  title: string;
  subtitle?: string;
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

const CHARS_PER_TOKEN = 1 / 0.3;

export function attachmentCharBudget(inputTokenBudget: number): number {
  return Math.max(2_000, Math.floor(inputTokenBudget * 0.6 * CHARS_PER_TOKEN));
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit * 0.8);
  const tail = limit - head;
  return {
    text: `${text.slice(0, head)}\n\n[… ${text.length - limit} characters omitted to fit the model's context …]\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

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
