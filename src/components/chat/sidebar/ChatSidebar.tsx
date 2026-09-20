// The chat page's left sidebar: New chat, then four sections — Email, Google
// Drive, Workspace, History — whose content fills the space below the list.
// Collapses to an icon rail; the open section and collapsed state are
// remembered per viewer.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FolderOpen, HardDrive, History, Mail, PanelLeftClose, PanelLeftOpen, SquarePen } from 'lucide-react';
import { useLlm } from '../../../state/LlmContext';
import ConversationSidebar from '../ConversationSidebar';
import { EmailPanel } from './EmailPanel';
import { DrivePanel } from './DrivePanel';
import { WorkspacePanel } from './WorkspacePanel';
import { AccountArea, RailAccount } from './AppLogin';
import { SidebarResizer } from './SidebarResizer';

export type SidebarSection = 'email' | 'drive' | 'workspace' | 'history';

const SECTION_KEY = 'imaginarium.chatSidebar.section';
const COLLAPSED_KEY = 'imaginarium.chatSidebar.collapsed';
const WIDTH_KEY = 'imaginarium.chatSidebar.width';

const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;
/** Dragging narrower than this collapses to the rail instead. */
const COLLAPSE_AT = 190;
/** The chat itself always keeps at least this much room. */
const CHAT_MIN = 420;

function clampWidth(value: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - CHAT_MIN));
  return Math.round(Math.max(MIN_WIDTH, Math.min(value, max)));
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* per-session only */
  }
}

const SECTIONS: { id: SidebarSection; label: string; icon: ReactNode }[] = [
  { id: 'email', label: 'Email', icon: <Mail size={17} /> },
  { id: 'drive', label: 'Google Drive', icon: <HardDrive size={17} /> },
  { id: 'workspace', label: 'Workspace', icon: <FolderOpen size={17} /> },
  { id: 'history', label: 'History', icon: <History size={17} /> },
];

export default function ChatSidebar() {
  const { newChat, conversations, workspace } = useLlm();
  const [section, setSectionState] = useState<SidebarSection>(() => {
    const saved = read(SECTION_KEY);
    return SECTIONS.some((s) => s.id === saved) ? (saved as SidebarSection) : 'history';
  });
  const [collapsed, setCollapsedState] = useState(() => read(COLLAPSED_KEY) === '1');
  const [width, setWidthState] = useState(() => {
    const saved = Number(read(WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : DEFAULT_WIDTH;
  });

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    write(WIDTH_KEY, String(clamped));
  }, []);

  // Shrinking the window must not push the chat out of the way.
  useEffect(() => {
    const onResize = () => setWidthState((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setSection = (s: SidebarSection) => {
    setSectionState(s);
    write(SECTION_KEY, s);
  };
  const setCollapsed = (c: boolean) => {
    setCollapsedState(c);
    write(COLLAPSED_KEY, c ? '1' : '0');
  };

  const badge = (id: SidebarSection) =>
    id === 'history' && conversations.length ? String(conversations.length) : id === 'workspace' && workspace ? workspace.name : '';

  if (collapsed) {
    return (
      <aside className="glass flex h-full w-[60px] shrink-0 flex-col items-center gap-1 rounded-[var(--radius-panel)] py-3" aria-label="Chat sidebar">
        <RailButton label="Expand sidebar" onClick={() => setCollapsed(false)}>
          <PanelLeftOpen size={17} />
        </RailButton>
        <div className="my-1 h-px w-8 bg-white/10" />
        <RailButton label="New chat" onClick={newChat} accent>
          <SquarePen size={17} />
        </RailButton>
        {SECTIONS.map((s) => (
          <RailButton
            key={s.id}
            label={s.label}
            active={section === s.id}
            onClick={() => {
              setSection(s.id);
              setCollapsed(false);
            }}
          >
            {s.icon}
          </RailButton>
        ))}
        <div className="mt-auto">
          <RailAccount onExpand={() => setCollapsed(false)} />
        </div>
      </aside>
    );
  }

  return (
    <>
      <aside
        className="glass flex h-full shrink-0 flex-col overflow-hidden rounded-[var(--radius-panel)]"
        style={{ width }}
        aria-label="Chat sidebar"
      >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <button
          onClick={newChat}
          className="neon-glow flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--color-neon)] px-3 py-2 text-[13px] font-semibold text-black transition hover:brightness-110"
        >
          <SquarePen size={15} /> New chat
        </button>
        <button
          onClick={() => setCollapsed(true)}
          className="rounded-lg p-2 text-white/50 transition hover:bg-white/10 hover:text-white"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose size={17} />
        </button>
      </div>

      <nav className="space-y-0.5 px-2 pb-2" aria-label="Sidebar sections">
        {SECTIONS.map((s) => {
          const active = section === s.id;
          const b = badge(s.id);
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                active ? 'bg-[var(--color-neon)]/15 text-white' : 'text-white/65 hover:bg-white/5 hover:text-white'
              }`}
            >
              {active && <span className="neon-glow absolute inset-y-2 left-0 w-[3px] rounded-full bg-[var(--color-neon)]" />}
              <span className={active ? 'text-[var(--color-neon)]' : 'text-white/50'}>{s.icon}</span>
              <span className="flex-1">{s.label}</span>
              {b && (
                <span
                  className={`max-w-[90px] truncate rounded-full px-1.5 text-[10px] ${
                    s.id === 'history' ? 'bg-white/10 text-white/60' : 'text-white/35'
                  }`}
                >
                  {b}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 border-t border-white/8">
        {section === 'email' && <EmailPanel />}
        {section === 'drive' && <DrivePanel />}
        {section === 'workspace' && <WorkspacePanel />}
        {section === 'history' && <ConversationSidebar embedded />}
      </div>

      <AccountArea />
      </aside>
      <SidebarResizer
        width={width}
        onResize={setWidth}
        onReset={() => setWidth(DEFAULT_WIDTH)}
        onCollapse={(restoreWidth) => {
          // Keep the width the user had, so expanding returns to it.
          setWidth(restoreWidth);
          setCollapsed(true);
        }}
        collapseAt={COLLAPSE_AT}
      />
    </>
  );
}

function RailButton({
  label,
  onClick,
  active,
  accent,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid h-10 w-10 place-items-center rounded-xl transition ${
        accent
          ? 'neon-glow bg-[var(--color-neon)] text-black hover:brightness-110'
          : active
            ? 'bg-[var(--color-neon)]/15 text-[var(--color-neon)]'
            : 'text-white/55 hover:bg-white/5 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}
