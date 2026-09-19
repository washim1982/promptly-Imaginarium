// Sidebar → Email: the connected Gmail inbox, searchable, with a preview that
// attaches a message to the chat. Read-only.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Paperclip, RefreshCw, Search } from 'lucide-react';
import { googleApi, senderName, shortDate, type MailMessage, type MailSummary } from '../../../lib/google';
import { useLlm } from '../../../state/LlmContext';
import { AccountStrip, GoogleGate } from './GoogleAccount';
import { PreviewModal, type PreviewState } from './PreviewModal';

function toPreview(m: MailMessage): PreviewState {
  return {
    title: m.subject,
    meta: [
      { label: 'From', value: m.from },
      { label: 'To', value: m.to },
      ...(m.cc ? [{ label: 'Cc', value: m.cc }] : []),
      { label: 'Date', value: new Date(m.date).toLocaleString() },
      ...(m.attachments.length ? [{ label: 'Files', value: `${m.attachments.join(', ')} (not included)` }] : []),
    ],
    body: m.body,
    link: { label: 'Open in Gmail', url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.threadId)}` },
  };
}

/** What the model gets for an email: headers, then the body. */
function emailText(m: MailMessage): string {
  return [
    `From: ${m.from}`,
    `To: ${m.to}`,
    m.cc ? `Cc: ${m.cc}` : '',
    `Date: ${new Date(m.date).toString()}`,
    `Subject: ${m.subject}`,
    m.attachments.length ? `Attachments (not included): ${m.attachments.join(', ')}` : '',
    '',
    m.body,
  ]
    .filter((l, i) => l || i === 6)
    .join('\n');
}

export function EmailPanel() {
  return (
    <GoogleGate need="gmail">
      <Inbox />
    </GoogleGate>
  );
}

function Inbox() {
  const { addAttachment } = useLlm();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [messages, setMessages] = useState<MailSummary[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{ id: string; message?: MailMessage; error: string } | null>(null);
  const [attached, setAttached] = useState<Set<string>>(new Set());

  const load = useCallback(async (q: string, pageToken?: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await googleApi.listMail(q, pageToken);
      setMessages((prev) => (pageToken ? [...prev, ...res.messages] : res.messages));
      setNext(res.nextPageToken);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  const attach = (m: MailMessage) => {
    addAttachment({ kind: 'email', title: m.subject, subtitle: senderName(m.from), text: emailText(m) });
    setAttached((s) => new Set(s).add(m.id));
  };

  const openMessage = async (id: string) => {
    setOpen({ id, error: '' });
    try {
      const message = await googleApi.getMail(id);
      setOpen((o) => (o?.id === id ? { id, message, error: '' } : o));
    } catch (err) {
      setOpen((o) => (o?.id === id ? { id, error: (err as Error).message } : o));
    }
  };

  const quickAttach = async (id: string) => {
    try {
      attach(await googleApi.getMail(id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <AccountStrip />
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(query);
          void load(query);
        }}
      >
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-white/10 bg-black/25 px-2 focus-within:border-[var(--color-neon)]/50">
          <Search size={13} className="shrink-0 text-white/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mail (from:, subject:…)"
            aria-label="Search mail"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => void load(applied)}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh mail"
          className="rounded-lg border border-white/10 p-1.5 text-white/55 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </form>
      <p className="mono px-0.5 text-[9.5px] uppercase tracking-wider text-white/30">{applied ? `Results · ${applied}` : 'Inbox'}</p>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {error && <p className="px-1 py-2 text-[11.5px] leading-relaxed text-red-300">{error}</p>}
        {!loading && !error && messages.length === 0 && <p className="px-1 py-6 text-center text-[12px] text-white/35">No messages.</p>}
        {messages.map((m) => (
          <div
            key={m.id}
            role="button"
            tabIndex={0}
            onClick={() => void openMessage(m.id)}
            onKeyDown={(e) => e.key === 'Enter' && void openMessage(m.id)}
            className="group relative mb-0.5 cursor-pointer rounded-lg px-2 py-2 transition hover:bg-white/5"
          >
            <div className="flex items-baseline gap-2">
              {m.unread && <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-[var(--color-neon)]" title="Unread" />}
              <span className={`min-w-0 flex-1 truncate text-[12.5px] ${m.unread ? 'font-semibold text-white' : 'text-white/80'}`}>
                {senderName(m.from)}
              </span>
              <span className="shrink-0 text-[10.5px] text-white/35">{shortDate(m.date)}</span>
            </div>
            <p className={`truncate text-[12px] ${m.unread ? 'text-white/85' : 'text-white/60'}`}>{m.subject}</p>
            <p className="truncate text-[11px] text-white/35">{m.snippet}</p>
            <button
              className={`absolute right-1.5 top-7 rounded-md border border-white/10 bg-[#16141f] p-1 transition hover:text-white ${
                attached.has(m.id) ? 'text-[var(--color-neon)] opacity-100' : 'text-white/55 opacity-0 group-hover:opacity-100'
              }`}
              title={attached.has(m.id) ? 'Attached' : 'Attach to chat'}
              aria-label={`Attach "${m.subject}" to chat`}
              onClick={(e) => {
                e.stopPropagation();
                void quickAttach(m.id);
              }}
            >
              <Paperclip size={12} />
            </button>
          </div>
        ))}
        {loading && (
          <div className="grid place-items-center py-4 text-white/40">
            <Loader2 className="animate-spin" size={16} />
          </div>
        )}
        {!loading && next && (
          <button
            className="mono mt-1 w-full rounded-lg py-2 text-[10px] uppercase tracking-wider text-white/45 transition hover:bg-white/5 hover:text-white"
            onClick={() => void load(applied, next)}
          >
            Load more
          </button>
        )}
      </div>

      {open && (
        <PreviewModal
          preview={open.message ? toPreview(open.message) : null}
          loading={!open.message && !open.error}
          error={open.error}
          footerNote="Attached mail is read by the local model only — nothing is sent anywhere."
          onAttach={() => {
            if (open.message) attach(open.message);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
