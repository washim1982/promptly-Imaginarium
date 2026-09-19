import { useEffect, useRef } from 'react';
import { useLlm } from '../../state/LlmContext';
import { CHAT_WIDTH_CLASS } from '../../lib/ui';
import Composer from './Composer';
import Message from './Message';
import ModelLoader from './ModelLoader';
import ChatSidebar from './sidebar/ChatSidebar';
import UnsupportedScreen from '../UnsupportedScreen';

export default function Chat() {
  const { status, messages, gpu, chatWidth } = useLlm();
  const widthClass = CHAT_WIDTH_CLASS[chatWidth];
  const endRef = useRef<HTMLDivElement>(null);

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

  const main =
    status !== 'ready' ? (
      // Model not yet loaded -> the dual-source loader. The sidebar stays
      // usable meanwhile (mail, Drive and history don't need the model).
      <Centered>
        <ModelLoader />
        {gpu?.adapter && <p className="mono mt-4 text-[10px] text-white/30">GPU: {gpu.adapter}</p>}
      </Centered>
    ) : messages.length === 0 ? (
      // "Welcome back" hero (empty / new chat).
      <div className="flex h-full flex-col items-center justify-center px-4">
        <div className="w-full max-w-2xl text-center">
          <div className="neon-glow mx-auto mb-6 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--color-neon)]/20 text-3xl text-[var(--color-neon)]">
            ✦
          </div>
          <h1 className="text-4xl font-semibold text-white">Welcome back</h1>
          <p className="mt-2 text-white/50">How can I assist your workflow today?</p>
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
    );

  // Sidebar (New chat · Email · Google Drive · Workspace · History) + chat.
  return (
    <div className="flex h-full gap-3 overflow-hidden px-3 pb-3">
      <ChatSidebar />
      <div className="h-full min-w-0 flex-1">{main}</div>
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
