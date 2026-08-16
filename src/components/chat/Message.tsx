import type { ChatMessage } from '../../state/LlmContext';
import { domainOf } from '../../lib/search';
import Markdown from './Markdown';

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div className="mono mb-1 flex items-center justify-end gap-2 text-[10px] text-white/40">
            <span>👤 YOU</span>
            <span>·</span>
            <span>{time(message.createdAt)}</span>
          </div>
          <div className="glass whitespace-pre-wrap rounded-2xl px-4 py-3 text-[15px] leading-relaxed text-white">
            {message.text}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="neon-glow mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-neon)]/20 text-sm text-[var(--color-neon)]">
        ✦
      </div>
      <div className="min-w-0 flex-1">
        <div className="mono mb-1 flex items-center gap-2 text-[10px] text-white/40">
          <span>IMAGINARIUM</span>
          <span>·</span>
          <span>{time(message.createdAt)}</span>
        </div>
        {message.searching ? (
          <span className="mono inline-flex items-center gap-2 text-[12px] text-[var(--color-teal)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-teal)]" />
            🔎 Searching the web…
          </span>
        ) : message.text ? (
          <Markdown>{message.text}</Markdown>
        ) : (
          <span className="text-white/40">…</span>
        )}
        {message.streaming && !message.searching && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--color-neon)] align-middle" />
        )}

        {message.sources && message.sources.length > 0 && (
          <div className="mt-3 border-t border-white/5 pt-2">
            <div className="mono mb-1.5 text-[10px] uppercase tracking-wider text-white/35">
              Sources
            </div>
            <div className="flex flex-wrap gap-1.5">
              {message.sources.map((s, i) => (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={s.title}
                  className="glass mono flex max-w-[240px] items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-white/60 transition hover:text-white"
                >
                  <span className="text-[var(--color-neon)]">[{i + 1}]</span>
                  <span className="truncate">{domainOf(s.url)}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
