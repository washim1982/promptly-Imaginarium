import { useRef } from 'react';
import { useLlm } from '../../state/LlmContext';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function ConversationSidebar({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const {
    conversations,
    activeConversationId,
    newChat,
    loadConversation,
    deleteConversation,
    renameConversation,
    exportHistory,
    importHistory,
  } = useLlm();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <aside className="glass flex h-full w-full flex-col rounded-[var(--radius-panel)] p-3">
      <button
        onClick={() => {
          newChat();
          onNavigate?.();
        }}
        className="neon-glow mb-3 flex items-center justify-center gap-1 rounded-xl bg-[var(--color-neon)] px-3 py-2 text-sm font-semibold text-black transition hover:brightness-110"
      >
        ＋ New chat
      </button>

      <div className="-mr-1 flex-1 space-y-1 overflow-y-auto pr-1">
        {conversations.length === 0 ? (
          <p className="mono mt-6 px-2 text-center text-[10px] leading-relaxed text-white/30">
            No saved chats yet. Your conversations are stored privately in this
            browser.
          </p>
        ) : (
          conversations.map((c) => {
            const active = c.id === activeConversationId;
            return (
              <div
                key={c.id}
                onClick={() => {
                  loadConversation(c.id);
                  onNavigate?.();
                }}
                className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition ${
                  active
                    ? 'bg-[var(--color-neon)]/15 text-white'
                    : 'text-white/70 hover:bg-white/5'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">{c.title}</p>
                  <p className="mono text-[9px] text-white/35">
                    {relativeTime(c.updatedAt)}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const t = window.prompt('Rename conversation', c.title);
                    if (t != null) renameConversation(c.id, t);
                  }}
                  title="Rename"
                  className="shrink-0 text-white/30 opacity-0 transition hover:text-white group-hover:opacity-100"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete "${c.title}"?`))
                      deleteConversation(c.id);
                  }}
                  title="Delete"
                  className="shrink-0 text-white/30 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                >
                  🗑
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="mono mt-3 flex items-center justify-between border-t border-white/5 pt-3 text-[10px] text-white/40">
        <button onClick={exportHistory} className="hover:text-white">
          ⭳ Export
        </button>
        <button onClick={() => fileRef.current?.click()} className="hover:text-white">
          ⭱ Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importHistory(f);
            e.target.value = '';
          }}
        />
      </div>
    </aside>
  );
}
