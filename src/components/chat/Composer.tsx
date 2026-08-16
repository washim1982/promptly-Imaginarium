import { useRef, useState } from 'react';
import { useLlm } from '../../state/LlmContext';
import StatusPill from './StatusPill';

export default function Composer({ compact = false }: { compact?: boolean }) {
  const {
    status,
    isGenerating,
    send,
    cancel,
    messages,
    newChat,
    webSearchEnabled,
    setWebSearchEnabled,
  } = useLlm();
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const ready = status === 'ready';

  function submit() {
    if (!ready || isGenerating || !text.trim()) return;
    send(text);
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function autoGrow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }

  return (
    <div className="w-full">
      <div className="glass neon-glow rounded-[var(--radius-panel)] px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={
              ready ? 'Type a message or command…' : 'Load a model to start chatting…'
            }
            className="max-h-[200px] flex-1 resize-none bg-transparent py-1 text-[15px] text-white placeholder:text-white/35 focus:outline-none"
          />
          {isGenerating ? (
            <button
              onClick={cancel}
              className="grid h-9 w-9 place-items-center rounded-full bg-red-500/80 text-white transition hover:bg-red-500"
              aria-label="Stop"
            >
              ■
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!ready || !text.trim()}
              className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-30"
              aria-label="Send"
            >
              ↑
            </button>
          )}
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-2">
          <div className="flex items-center gap-2">
            <StatusPill />
            <button
              type="button"
              onClick={() => setWebSearchEnabled(!webSearchEnabled)}
              aria-pressed={webSearchEnabled}
              title={
                webSearchEnabled
                  ? 'Web search on — replies are grounded in live results'
                  : 'Web search off — replies use local knowledge only'
              }
              className={`mono flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition ${
                webSearchEnabled
                  ? 'neon-glow border-[var(--color-neon)]/50 bg-[var(--color-neon)]/15 text-white'
                  : 'border-white/15 text-white/55 hover:bg-white/10 hover:text-white'
              }`}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              Web
            </button>
          </div>
          {messages.length > 0 && (
            <button
              onClick={newChat}
              className="mono flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-[10px] text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              ＋ New chat
            </button>
          )}
        </div>
      </div>

      {compact && (
        <p className="mono mt-4 text-center text-[10px] text-white/30">
          Press <kbd className="rounded bg-white/10 px-1.5 py-0.5">Enter</kbd> to
          send · Shift+Enter for newline
        </p>
      )}
    </div>
  );
}
