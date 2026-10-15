// File Viewer — open Markdown, HTML and code files and read them.
//
// Three renderers behind one pane:
//   Markdown  react-markdown, the same component chat replies use
//   HTML      a sandboxed iframe: no scripts, opaque origin, and a policy that
//             blocks remote loads so a local file cannot call home
//   code      Monaco, read-only, shared with SVN Studio
//
// Every file also has a Source view, because "what does this actually say"
// is half the reason to open a viewer at all.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Code2,
  Eye,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  X,
} from 'lucide-react';
import Markdown from '../components/chat/Markdown';
import { useLlm } from '../state/LlmContext';
import { cleanError } from '../lib/desktop';
import { resolveAccent } from '../lib/themes';
import {
  formatBytes,
  kindOf,
  sandboxHtml,
  viewerApi,
  type FileContents,
  type FileKind,
  type FileRef,
} from '../lib/viewer';

const MonacoViewer = lazy(() => import('../components/viewer/MonacoViewer'));

const OPEN_FILES_KEY = 'imaginarium.viewer.openFiles';

const ICON: Record<FileKind, typeof FileText> = {
  markdown: FileText,
  html: Globe,
  code: FileCode2,
};

function readStoredPaths(): string[] {
  try {
    const raw = window.localStorage.getItem(OPEN_FILES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

export default function FileViewer() {
  const { theme, customGlow, appearance } = useLlm();
  const [files, setFiles] = useState<FileRef[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [contents, setContents] = useState<FileContents | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dropDepth = useRef(0);

  const accent = resolveAccent(theme, customGlow);

  // Re-open what was open last time. Paths the main process no longer trusts
  // (a new session) simply fail to read, and are dropped from the list.
  useEffect(() => {
    const saved = readStoredPaths();
    if (!saved.length) return;
    void viewerApi
      .accept(saved)
      .then((refs) => {
        setFiles(refs);
        if (refs[0]) setActivePath(refs[0].path);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_FILES_KEY, JSON.stringify(files.map((f) => f.path)));
    } catch {
      /* a viewer that can't remember its tabs still works */
    }
  }, [files]);

  const load = useCallback(async (file: string) => {
    setLoading(true);
    setError('');
    try {
      setContents(await viewerApi.read(file));
    } catch (err) {
      setContents(null);
      setError(cleanError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activePath) void load(activePath);
    else setContents(null);
  }, [activePath, load]);

  const add = (refs: FileRef[]) => {
    if (!refs.length) return;
    setFiles((current) => {
      const merged = [...current];
      for (const ref of refs) {
        const at = merged.findIndex((f) => f.path === ref.path);
        if (at >= 0) merged[at] = ref;
        else merged.push(ref);
      }
      return merged.slice(-20);
    });
    setActivePath(refs[refs.length - 1].path);
    setShowSource(false);
  };

  const open = async () => {
    try {
      add(await viewerApi.pick());
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const close = (target: string) => {
    setFiles((current) => {
      const next = current.filter((f) => f.path !== target);
      if (target === activePath) setActivePath(next[next.length - 1]?.path ?? null);
      return next;
    });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dropDepth.current = 0;
    setDragging(false);
    const paths: string[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      try {
        const p = viewerApi.pathForFile(file);
        if (p) paths.push(p);
      } catch {
        /* not a real file drop */
      }
    }
    if (!paths.length) return;
    try {
      add(await viewerApi.accept(paths));
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const kind = contents ? kindOf(contents.name) : 'code';
  const rendered = !showSource && (kind === 'markdown' || kind === 'html');

  return (
    <div
      className="flex h-full gap-3 overflow-hidden px-3 pb-3"
      onDragEnter={(e) => {
        e.preventDefault();
        dropDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dropDepth.current -= 1;
        if (dropDepth.current <= 0) setDragging(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      {sidebar && (
        <aside className="glass flex w-64 shrink-0 flex-col rounded-2xl p-3">
          <button
            onClick={() => void open()}
            className="neon-glow mb-3 flex items-center justify-center gap-2 rounded-xl bg-[var(--color-neon)]/20 px-3 py-2.5 text-sm font-semibold text-[var(--color-neon)] transition hover:bg-[var(--color-neon)]/30"
          >
            <FolderOpen size={16} /> Open files
          </button>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {files.map((f) => {
              const Icon = ICON[kindOf(f.name)];
              const active = f.path === activePath;
              return (
                <div
                  key={f.path}
                  className={`group flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                    active ? 'bg-[var(--color-neon)]/15 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2"
                    onClick={() => {
                      setActivePath(f.path);
                      setShowSource(false);
                    }}
                    title={f.path}
                  >
                    <Icon size={14} className="shrink-0 text-[var(--color-neon)]" />
                    <span className="truncate text-[13px]">{f.name}</span>
                  </button>
                  <button
                    onClick={() => close(f.path)}
                    className="shrink-0 text-white/25 opacity-0 transition hover:text-white group-hover:opacity-100"
                    aria-label={`Close ${f.name}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {!files.length && (
              <p className="mono px-1 py-6 text-center text-[10px] leading-relaxed text-white/30">
                No files open. Choose some, or drop them anywhere on this page.
              </p>
            )}
          </div>
        </aside>
      )}

      <section className="glass flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-white/5 px-3 py-2">
          <button
            onClick={() => setSidebar((s) => !s)}
            className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/5 hover:text-white"
            aria-label={sidebar ? 'Hide the file list' : 'Show the file list'}
          >
            {sidebar ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>

          {contents ? (
            <>
              <span className="truncate text-sm text-white" title={contents.path}>
                {contents.name}
              </span>
              <span className="mono shrink-0 text-[10px] uppercase tracking-wider text-white/35">
                {kind} · {formatBytes(contents.size)}
                {contents.truncated && ' · truncated'}
              </span>
              <span className="flex-1" />
              {(kind === 'markdown' || kind === 'html') && (
                <button
                  onClick={() => setShowSource((s) => !s)}
                  className="glass mono flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-white/60 transition hover:text-white"
                >
                  {showSource ? <Eye size={13} /> : <Code2 size={13} />}
                  {showSource ? 'Rendered' : 'Source'}
                </button>
              )}
              <button
                onClick={() => void load(contents.path)}
                className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/5 hover:text-white"
                aria-label="Reload from disk"
                title="Reload from disk"
              >
                <RefreshCw size={15} />
              </button>
              <button
                onClick={() => void viewerApi.reveal(contents.path)}
                className="glass mono rounded-lg px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-white/60 transition hover:text-white"
              >
                Show in folder
              </button>
            </>
          ) : (
            <span className="text-sm text-white/40">File Viewer</span>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading && (
            <div className="flex h-full items-center justify-center gap-2 text-white/50">
              <Loader2 className="animate-spin" size={18} /> Reading…
            </div>
          )}

          {!loading && error && (
            <div className="flex h-full items-center justify-center px-8">
              <p className="max-w-md text-center text-sm text-red-300">{error}</p>
            </div>
          )}

          {!loading && !error && !contents && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <div className="neon-glow grid h-14 w-14 place-items-center rounded-2xl bg-[var(--color-neon)]/20 text-2xl text-[var(--color-neon)]">
                <FileText size={24} />
              </div>
              <h2 className="text-lg font-semibold text-white">Open a file to read it</h2>
              <p className="max-w-sm text-sm text-white/50">
                Markdown and HTML render; everything else opens in a read-only editor. Drop files anywhere on this
                page, or use Open files.
              </p>
            </div>
          )}

          {!loading && !error && contents && rendered && kind === 'markdown' && (
            <div className="h-full overflow-y-auto px-8 py-6">
              <div className="mx-auto max-w-3xl">
                <Markdown>{contents.text}</Markdown>
              </div>
            </div>
          )}

          {!loading && !error && contents && rendered && kind === 'html' && (
            <iframe
              // Scripts off, opaque origin, remote loads blocked by the policy
              // injected in sandboxHtml. Nothing in the file can reach the app.
              sandbox=""
              referrerPolicy="no-referrer"
              title={`Preview of ${contents.name}`}
              srcDoc={sandboxHtml(contents.text)}
              className="h-full w-full border-0 bg-white"
            />
          )}

          {!loading && !error && contents && !rendered && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-2 text-white/50">
                  <Loader2 className="animate-spin" size={18} /> Loading the editor…
                </div>
              }
            >
              <MonacoViewer path={contents.path} text={contents.text} accent={accent} appearance={appearance} />
            </Suspense>
          )}
        </div>
      </section>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 m-3 rounded-3xl border-2 border-dashed border-[var(--color-neon)]/70 bg-black/40 backdrop-blur-sm">
          <div className="flex h-full items-center justify-center">
            <p className="mono text-sm uppercase tracking-widest text-[var(--color-neon)]">Drop to open</p>
          </div>
        </div>
      )}
    </div>
  );
}
