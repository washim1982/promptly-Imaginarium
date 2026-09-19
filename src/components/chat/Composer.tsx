import { useRef, useState } from 'react';
import { useLlm } from '../../state/LlmContext';
import StatusPill from './StatusPill';
import AttachmentChip from './AttachmentChip';

export default function Composer({ compact = false }: { compact?: boolean }) {
  const {
    status,
    isGenerating,
    send,
    cancel,
    messages,
    attachments,
    removeAttachment,
    agentEnabled,
    setAgentEnabled,
    workspace,
    pickWorkspace,
  } = useLlm();
  // Context usage of the latest agent round, for the meter.
  const usage = [...messages].reverse().find((m) => m.agent?.usage)?.agent?.usage;
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const ready = status === 'ready';

  function submit() {
    if (!ready || isGenerating || (!text.trim() && !attachments.length)) return;
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
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 border-b border-white/5 pb-2">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}
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
              !ready
                ? 'Load a model to start chatting…'
                : attachments.length
                  ? 'Ask about the attached item — or press Enter to summarize it…'
                  : 'Type a message or command…'
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
              disabled={!ready || (!text.trim() && !attachments.length)}
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
              onClick={() => setAgentEnabled(!agentEnabled)}
              aria-pressed={agentEnabled}
              title={
                agentEnabled
                  ? 'Agent on — the model can search the web, read your workspace and (with your approval) write files and run commands'
                  : 'Agent off — plain chat'
              }
              className={`mono flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition ${
                agentEnabled
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
                <rect x="4" y="8" width="16" height="12" rx="3" />
                <path d="M12 8V4M9 14h.01M15 14h.01M2 13v3M22 13v3" />
              </svg>
              Agent
            </button>
            {agentEnabled && (
              <button
                type="button"
                onClick={() => void pickWorkspace()}
                title={workspace ? `Workspace: ${workspace.path} — click to change` : 'Choose the folder the agent may work in'}
                className={`mono flex max-w-[180px] items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition hover:bg-white/10 hover:text-white ${
                  workspace ? 'border-white/15 text-white/70' : 'border-dashed border-white/20 text-white/45'
                }`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
                </svg>
                <span className="truncate">{workspace ? workspace.name : 'No workspace'}</span>
              </button>
            )}
            {agentEnabled && usage && (
              <span
                className="mono text-[10px] text-white/35"
                title="Estimated tokens in the last agent request / input budget for this model. Older context is compacted at 85%."
              >
                CTX {(usage.used / 1000).toFixed(1)}K/{(usage.budget / 1000).toFixed(1)}K
              </span>
            )}
          </div>
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
