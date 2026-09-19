// Sidebar → Workspace: the folder the agent works in (the same one the
// composer's workspace chip sets), as a browsable tree. Files can be previewed
// and attached to a message.

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, FolderPlus, Loader2, Paperclip, RefreshCw, X } from 'lucide-react';
import { useLlm } from '../../../state/LlmContext';
import { cleanError, requireDesktop } from '../../../lib/desktop';
import { panelButton, primaryButton } from './styles';
import { PreviewModal } from './PreviewModal';

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface WorkspaceBridge {
  listEntries(rel: string): Promise<Entry[]>;
  readForAttach(rel: string): Promise<{ name: string; text: string }>;
}
const bridge = () => (requireDesktop() as unknown as { agent: WorkspaceBridge }).agent;

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function WorkspacePanel() {
  const { workspace, pickWorkspace, clearWorkspace, addAttachment, agentEnabled, setAgentEnabled } = useLlm();
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDir, setLoadingDir] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{ entry: Entry; text?: string; error: string } | null>(null);
  const [attached, setAttached] = useState<Set<string>>(new Set());

  const loadDir = useCallback(async (rel: string) => {
    setLoadingDir(rel);
    setError('');
    try {
      const list = await bridge().listEntries(rel);
      setChildren((c) => ({ ...c, [rel]: list }));
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setLoadingDir(null);
    }
  }, []);

  // A new workspace starts from a fresh tree.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    if (workspace) void loadDir('.');
  }, [workspace, loadDir]);

  const toggle = (e: Entry) => {
    const opening = !expanded.has(e.path);
    if (opening && !children[e.path]) void loadDir(e.path);
    setExpanded((s) => {
      const next = new Set(s);
      if (opening) next.add(e.path);
      else next.delete(e.path);
      return next;
    });
  };

  const read = async (e: Entry) => (await bridge().readForAttach(e.path)).text;

  const attach = (e: Entry, text: string) => {
    addAttachment({ kind: 'file', title: e.name, subtitle: e.path, text });
    setAttached((s) => new Set(s).add(e.path));
  };

  const openFile = async (e: Entry) => {
    setOpen({ entry: e, error: '' });
    try {
      const text = await read(e);
      setOpen((o) => (o?.entry.path === e.path ? { entry: e, text, error: '' } : o));
    } catch (err) {
      setOpen((o) => (o?.entry.path === e.path ? { entry: e, error: cleanError(err) } : o));
    }
  };

  if (!workspace) {
    return (
      <div className="space-y-3 p-3">
        <p className="text-[13px] font-semibold text-white">No workspace yet</p>
        <p className="text-[11.5px] leading-relaxed text-white/50">
          Choose a folder to browse its files here and attach them to a message. In Agent mode the model can also read it
          and — with your approval — edit files and run commands inside it.
        </p>
        <button className={`${primaryButton} w-full`} onClick={() => void pickWorkspace()}>
          <FolderPlus size={14} /> Choose folder
        </button>
      </div>
    );
  }

  const renderDir = (rel: string, depth: number): React.ReactNode =>
    (children[rel] ?? []).map((e) => (
      <div key={e.path}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => (e.isDir ? toggle(e) : void openFile(e))}
          onKeyDown={(ev) => ev.key === 'Enter' && (e.isDir ? toggle(e) : void openFile(e))}
          className="group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-1.5 text-[12.5px] text-white/75 transition hover:bg-white/5 hover:text-white"
          style={{ paddingLeft: 6 + depth * 14 }}
          title={e.isDir ? e.path : `${e.path} · ${fmtSize(e.size)}`}
        >
          {e.isDir ? (
            <>
              <ChevronRight size={12} className={`shrink-0 text-white/35 transition-transform ${expanded.has(e.path) ? 'rotate-90' : ''}`} />
              {expanded.has(e.path) ? <FolderOpen size={14} className="shrink-0 text-amber-300/80" /> : <Folder size={14} className="shrink-0 text-amber-300/80" />}
            </>
          ) : (
            <>
              <span className="w-3 shrink-0" />
              <FileText size={14} className="shrink-0 text-white/40" />
            </>
          )}
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          {loadingDir === e.path && <Loader2 size={12} className="animate-spin text-white/40" />}
          {!e.isDir && (
            <button
              className={`shrink-0 rounded p-0.5 transition hover:text-white ${
                attached.has(e.path) ? 'text-[var(--color-neon)]' : 'text-white/50 opacity-0 group-hover:opacity-100'
              }`}
              title={attached.has(e.path) ? 'Attached' : 'Attach to chat'}
              aria-label={`Attach ${e.name} to chat`}
              onClick={async (ev) => {
                ev.stopPropagation();
                try {
                  attach(e, await read(e));
                } catch (err) {
                  setError(`${e.name}: ${cleanError(err)}`);
                }
              }}
            >
              <Paperclip size={12} />
            </button>
          )}
        </div>
        {e.isDir && expanded.has(e.path) && renderDir(e.path, depth + 1)}
      </div>
    ));

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
        <FolderOpen size={14} className="shrink-0 text-amber-300/80" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white/85" title={workspace.path}>
          {workspace.name}
        </span>
        <button className="rounded p-1 text-white/45 hover:bg-white/10 hover:text-white" title="Refresh" aria-label="Refresh workspace" onClick={() => { setChildren({}); setExpanded(new Set()); void loadDir('.'); }}>
          <RefreshCw size={12} />
        </button>
        <button className="rounded p-1 text-white/45 hover:bg-white/10 hover:text-white" title="Stop using this folder" aria-label="Clear workspace" onClick={() => void clearWorkspace()}>
          <X size={12} />
        </button>
      </div>
      <div className="flex gap-1.5">
        <button className={`${panelButton} flex-1`} onClick={() => void pickWorkspace()}>
          Change folder
        </button>
        <button
          className={`${panelButton} flex-1 ${agentEnabled ? 'border-[var(--color-neon)]/50 bg-[var(--color-neon)]/15 text-white' : ''}`}
          onClick={() => setAgentEnabled(!agentEnabled)}
          title="Agent mode lets the model read this folder (and, with approval, edit files and run commands)"
        >
          Agent {agentEnabled ? 'on' : 'off'}
        </button>
      </div>
      {error && <p className="text-[11.5px] leading-relaxed text-red-300">{error}</p>}
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {loadingDir === '.' && !children['.'] ? (
          <div className="grid place-items-center py-6 text-white/40">
            <Loader2 className="animate-spin" size={16} />
          </div>
        ) : children['.']?.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-white/35">This folder is empty.</p>
        ) : (
          renderDir('.', 0)
        )}
      </div>

      {open && (
        <PreviewModal
          preview={
            open.text !== undefined
              ? { title: open.entry.name, meta: [{ label: 'Path', value: open.entry.path }, { label: 'Size', value: fmtSize(open.entry.size) }], body: open.text, mono: true }
              : null
          }
          loading={open.text === undefined && !open.error}
          error={open.error}
          onAttach={() => {
            if (open.text !== undefined) attach(open.entry, open.text);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
