// Read-only Gmail access (gmail.readonly): list/search messages and read one.

import { googleGet, requireScope } from './auth';
import { htmlToText } from '../agent/tools';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE_SIZE = 20;
const MAX_BODY_CHARS = 200_000;

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface MailMessage extends MailSummary {
  to: string;
  cc: string;
  body: string;
  attachments: string[];
}

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
}
interface RawMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: Part;
}

const header = (headers: Header[] | undefined, name: string) =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

// Gmail's snippet is HTML-escaped.
const unescapeSnippet = (s: string) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function summarize(raw: RawMessage): MailSummary {
  const h = raw.payload?.headers;
  return {
    id: raw.id,
    threadId: raw.threadId,
    from: header(h, 'From'),
    subject: header(h, 'Subject') || '(no subject)',
    date: raw.internalDate ? new Date(Number(raw.internalDate)).toISOString() : header(h, 'Date'),
    snippet: unescapeSnippet(raw.snippet ?? ''),
    unread: Boolean(raw.labelIds?.includes('UNREAD')),
  };
}

export async function listMessages(
  query: string,
  pageToken?: string,
): Promise<{ messages: MailSummary[]; nextPageToken?: string }> {
  await requireScope('gmail');
  const url = new URL(`${API}/messages`);
  url.searchParams.set('maxResults', String(PAGE_SIZE));
  // Gmail's own search syntax (from:, subject:, has:attachment, …) works as-is.
  url.searchParams.set('q', query.trim() || 'in:inbox');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const list = (await googleGet(url.toString())) as { messages?: { id: string }[]; nextPageToken?: string };

  const messages = await Promise.all(
    (list.messages ?? []).map(async ({ id }) => {
      const m = new URL(`${API}/messages/${encodeURIComponent(id)}`);
      m.searchParams.set('format', 'metadata');
      for (const name of ['From', 'Subject', 'Date']) m.searchParams.append('metadataHeaders', name);
      return summarize((await googleGet(m.toString())) as RawMessage);
    }),
  );
  return { messages, nextPageToken: list.nextPageToken };
}

const decode = (data: string) => Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** The best readable body: text/plain if there is one, otherwise HTML as text. */
export function extractBody(payload: Part | undefined): { body: string; attachments: string[] } {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  const walk = (part: Part | undefined) => {
    if (!part) return;
    if (part.filename && (part.body?.attachmentId || part.body?.size)) {
      attachments.push(part.filename);
      return;
    }
    const mime = (part.mimeType ?? '').toLowerCase();
    if (part.body?.data) {
      if (mime === 'text/plain') plain.push(decode(part.body.data));
      else if (mime === 'text/html') html.push(decode(part.body.data));
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  const body = plain.length ? plain.join('\n\n') : html.map((h) => htmlToText(h).text).join('\n\n');
  return { body: body.replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY_CHARS), attachments };
}

export async function getMessage(id: string): Promise<MailMessage> {
  await requireScope('gmail');
  if (!/^[\w-]+$/.test(String(id))) throw new Error('Invalid message id.');
  const raw = (await googleGet(`${API}/messages/${id}?format=full`)) as RawMessage;
  const h = raw.payload?.headers;
  return {
    ...summarize(raw),
    to: header(h, 'To'),
    cc: header(h, 'Cc'),
    ...extractBody(raw.payload),
  };
}
