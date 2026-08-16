import { useEffect, useRef, useState } from 'react';
import { useLlm } from '../../state/LlmContext';
import { CHAT_WIDTH_CLASS } from '../../lib/ui';
import Composer from './Composer';
import Message from './Message';
import ModelLoader from './ModelLoader';
import ConversationSidebar from './ConversationSidebar';
import UnsupportedScreen from '../UnsupportedScreen';

export default function Chat() {
  const { status, messages, gpu, chatWidth, conversations } = useLlm();
  const widthClass = CHAT_WIDTH_CLASS[chatWidth];
  const endRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // No WebGPU (also what crawlers see) — show the requirements page.
  if (status === 'unsupported') {
    return <UnsupportedScreen />;
  }

  // GPU check still running.
  if (status === 'checking-gpu') {
    return (
      <Centered>
        <p className="mono text-sm text-white/50">Checking GPU support…</p>
      </Centered>
    );
  }

  // Model not yet loaded -> show the dual-source loader.
  if (status !== 'ready') {
    return (
      <Centered>
        <ModelLoader />
        {gpu?.adapter && (
          <p className="mono mt-4 text-[10px] text-white/30">
            GPU: {gpu.adapter}
          </p>
        )}
      </Centered>
    );
  }

  // Ready: clean chat workspace; history lives in a slide-in drawer.
  return (
    <div className="relative h-full overflow-hidden">
      {/* History toggle — always visible, top-left, beautiful glass pill */}
      <button
        onClick={() => setHistoryOpen((v) => !v)}
        aria-label="Toggle chat history"
        title="Chat history"
        className={`group absolute left-4 top-4 z-40 flex h-10 items-center gap-2 rounded-xl px-3 text-sm transition-all ${
          historyOpen
            ? 'neon-glow bg-[var(--color-neon)]/15 text-white'
            : 'glass text-white/70 hover:text-white'
        }`}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform group-hover:scale-110"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
        </svg>
        <span className="mono text-[11px]">History</span>
        {conversations.length > 0 && (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-[var(--color-neon)] px-1 text-[9px] font-bold text-black">
            {conversations.length}
          </span>
        )}
      </button>

      {/* Backdrop */}
      <div
        onClick={() => setHistoryOpen(false)}
        className={`absolute inset-0 z-20 bg-black/40 backdrop-blur-[2px] transition-opacity duration-300 ${
          historyOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      {/* Slide-in history drawer */}
      <div
        className={`absolute inset-y-0 left-0 z-30 w-72 p-3 transition-transform duration-300 ease-out ${
          historyOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-full pt-12">
          <ConversationSidebar onNavigate={() => setHistoryOpen(false)} />
        </div>
      </div>

      <div className="h-full min-w-0 px-4 py-4">
        {messages.length === 0 ? (
          // "Welcome back" hero (empty / new chat).
          <div className="flex h-full flex-col items-center justify-center">
            <div className="w-full max-w-2xl text-center">
              <div className="neon-glow mx-auto mb-6 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--color-neon)]/20 text-3xl text-[var(--color-neon)]">
                ✦
              </div>
              <h1 className="text-4xl font-semibold text-white">Welcome back</h1>
              <p className="mt-2 text-white/50">
                How can I assist your workflow today?
              </p>
              <div className="mt-8">
                <Composer compact />
              </div>
            </div>
          </div>
        ) : (
          // Active conversation.
          <div className={`mx-auto flex h-full w-full flex-col ${widthClass}`}>
            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-2">
              {messages.map((m) => (
                <Message key={m.id} message={m} />
              ))}
              <div ref={endRef} />
            </div>
            <div className="px-4 pb-2">
              <Composer />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      {children}
    </div>
  );
}
