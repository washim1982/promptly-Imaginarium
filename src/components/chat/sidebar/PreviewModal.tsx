// Read an email / Drive file / workspace file before attaching it to chat.

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader2, Paperclip, X } from 'lucide-react';
import { openExternal } from '../../../lib/desktop';
import { primaryButton, panelButton } from './styles';

export interface PreviewState {
  title: string;
  /** Lines of metadata under the title (From / To / type / path…). */
  meta: { label: string; value: string }[];
  body: string;
  mono?: boolean;
  /** "Open in Gmail" / "Open in Drive". */
  link?: { label: string; url: string };
}

export function PreviewModal({
  preview,
  loading,
  error,
  footerNote,
  onAttach,
  onClose,
}: {
  preview: PreviewState | null;
  loading: boolean;
  error: string;
  footerNote?: ReactNode;
  onAttach: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portalled to <body>: the sidebar's backdrop-filter would otherwise become
  // the containing block for this fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/55 p-6 backdrop-blur-sm" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={preview?.title ?? 'Preview'}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-[var(--radius-panel)] border border-white/12 bg-[#16141f]/95 shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-white/8 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[16px] font-semibold text-white">{preview?.title ?? (loading ? 'Loading…' : 'Preview')}</h2>
            {preview && preview.meta.length > 0 && (
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
                {preview.meta.map((m) => (
                  <div key={m.label} className="contents">
                    <dt className="mono text-[10px] uppercase leading-5 text-white/35">{m.label}</dt>
                    <dd className="truncate leading-5 text-white/70" title={m.value}>
                      {m.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="min-h-[160px] flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="grid h-40 place-items-center text-white/40">
              <Loader2 className="animate-spin" size={20} />
            </div>
          ) : error ? (
            <p className="text-[13px] leading-relaxed text-red-300">{error}</p>
          ) : (
            <pre
              className={`whitespace-pre-wrap break-words text-white/85 ${
                preview?.mono ? 'font-mono text-[12px] leading-5' : 'font-sans text-[13.5px] leading-relaxed'
              }`}
            >
              {preview?.body || '(empty)'}
            </pre>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-white/8 px-5 py-3">
          <span className="min-w-0 flex-1 text-[11px] text-white/35">{footerNote}</span>
          {preview?.link && (
            <button className={panelButton} onClick={() => openExternal(preview.link!.url)}>
              <ExternalLink size={13} /> {preview.link.label}
            </button>
          )}
          <button className={primaryButton} disabled={loading || Boolean(error) || !preview} onClick={onAttach}>
            <Paperclip size={13} /> Attach to chat
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
