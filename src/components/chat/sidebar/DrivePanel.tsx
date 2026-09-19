// Sidebar → Google Drive: browse My Drive folder by folder or search all of
// Drive, preview a file as text and attach it to the chat. Read-only.

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, FileText, Folder, Loader2, Paperclip, RefreshCw, Search } from 'lucide-react';
import { driveKind, googleApi, shortDate, type DriveContent, type DriveFile } from '../../../lib/google';
import { useLlm } from '../../../state/LlmContext';
import { AccountStrip, GoogleGate } from './GoogleAccount';
import { PreviewModal, type PreviewState } from './PreviewModal';

interface Crumb {
  id: string;
  name: string;
}
const ROOT: Crumb = { id: 'root', name: 'My Drive' };

/** Drive content as plain text; PDFs go through the app's pdf.js. */
async function contentText(c: DriveContent): Promise<string> {
  if (c.kind === 'text') return c.text;
  const { extractPdfText } = await import('../../../lib/pdf');
  const doc = await extractPdfText(new File([new Uint8Array(c.bytes)], c.name, { type: 'application/pdf' }));
  if (!doc.text.trim()) throw new Error('This PDF has no text layer (it is probably scanned). Use PDF Tools → OCR on a downloaded copy.');
  return doc.text;
}

export function DrivePanel() {
  return (
    <GoogleGate need="drive">
      <Browser />
    </GoogleGate>
  );
}

function Browser() {
  const { addAttachment } = useLlm();
  const [path, setPath] = useState<Crumb[]>([ROOT]);
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{ file: DriveFile; text?: string; error: string } | null>(null);
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const folder = path[path.length - 1];

  const load = useCallback(async (search: string, folderId: string, pageToken?: string) => {
    setLoading(true);
    setError('');
    try {
      // A search covers all of Drive; browsing lists one folder.
      const res = await googleApi.listDrive(search, search ? undefined : folderId, pageToken);
      setFiles((prev) => (pageToken ? [...prev, ...res.files] : res.files));
      setNext(res.nextPageToken);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(applied, folder.id);
  }, [load, applied, folder.id]);

  const attach = (file: DriveFile, text: string) => {
    addAttachment({ kind: 'drive', title: file.name, subtitle: driveKind(file.mimeType), text });
    setAttached((s) => new Set(s).add(file.id));
  };

  const openFile = async (file: DriveFile) => {
    if (file.isFolder) {
      setQuery('');
      setApplied('');
      setPath((p) => [...p, { id: file.id, name: file.name }]);
      return;
    }
    setOpen({ file, error: '' });
    try {
      const text = await contentText(await googleApi.getDriveFile(file.id));
      setOpen((o) => (o?.file.id === file.id ? { file, text, error: '' } : o));
    } catch (err) {
      setOpen((o) => (o?.file.id === file.id ? { file, error: (err as Error).message } : o));
    }
  };

  const quickAttach = async (file: DriveFile) => {
    try {
      attach(file, await contentText(await googleApi.getDriveFile(file.id)));
    } catch (err) {
      setError(`${file.name}: ${(err as Error).message}`);
    }
  };

  const preview: PreviewState | null =
    open && open.text !== undefined
      ? {
          title: open.file.name,
          meta: [
            { label: 'Type', value: driveKind(open.file.mimeType) },
            ...(open.file.owner ? [{ label: 'Owner', value: open.file.owner }] : []),
            { label: 'Modified', value: new Date(open.file.modifiedTime).toLocaleString() },
          ],
          body: open.text,
          mono: !open.file.mimeType.startsWith('application/vnd.google-apps.document') && open.file.mimeType !== 'application/pdf',
          ...(open.file.webViewLink ? { link: { label: 'Open in Drive', url: open.file.webViewLink } } : {}),
        }
      : null;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <AccountStrip />
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(query.trim());
        }}
      >
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-white/10 bg-black/25 px-2 focus-within:border-[var(--color-neon)]/50">
          <Search size={13} className="shrink-0 text-white/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Drive"
            aria-label="Search Drive"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => void load(applied, folder.id)}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh Drive"
          className="rounded-lg border border-white/10 p-1.5 text-white/55 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </form>

      <nav className="mono flex min-w-0 flex-wrap items-center gap-0.5 px-0.5 text-[9.5px] uppercase tracking-wider text-white/35" aria-label="Drive folder">
        {applied ? (
          <>
            <span>Search · {applied}</span>
            <button className="ml-1 text-[var(--color-teal)] hover:underline" onClick={() => { setQuery(''); setApplied(''); }}>
              clear
            </button>
          </>
        ) : (
          path.map((c, i) => (
            <span key={c.id} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <ChevronRight size={10} />}
              <button
                className={`max-w-[120px] truncate ${i === path.length - 1 ? 'text-white/60' : 'hover:text-white'}`}
                onClick={() => setPath((p) => p.slice(0, i + 1))}
                disabled={i === path.length - 1}
              >
                {c.name}
              </button>
            </span>
          ))
        )}
      </nav>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {error && <p className="px-1 py-2 text-[11.5px] leading-relaxed text-red-300">{error}</p>}
        {!loading && !error && files.length === 0 && (
          <p className="px-1 py-6 text-center text-[12px] text-white/35">{applied ? 'No matching files.' : 'This folder is empty.'}</p>
        )}
        {files.map((f) => (
          <div
            key={f.id}
            role="button"
            tabIndex={0}
            onClick={() => void openFile(f)}
            onKeyDown={(e) => e.key === 'Enter' && void openFile(f)}
            className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-white/5"
            title={f.name}
          >
            {f.isFolder ? (
              <Folder size={15} className="shrink-0 text-amber-300/80" />
            ) : (
              <FileText size={15} className="shrink-0 text-[var(--color-teal)]" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] text-white/85">{f.name}</p>
              <p className="truncate text-[10.5px] text-white/35">
                {driveKind(f.mimeType)} · {shortDate(f.modifiedTime)}
              </p>
            </div>
            {!f.isFolder && (
              <button
                className={`shrink-0 rounded-md border border-white/10 p-1 transition hover:text-white ${
                  attached.has(f.id) ? 'text-[var(--color-neon)] opacity-100' : 'text-white/55 opacity-0 group-hover:opacity-100'
                }`}
                title={attached.has(f.id) ? 'Attached' : 'Attach to chat'}
                aria-label={`Attach ${f.name} to chat`}
                onClick={(e) => {
                  e.stopPropagation();
                  void quickAttach(f);
                }}
              >
                <Paperclip size={12} />
              </button>
            )}
          </div>
        ))}
        {loading && (
          <div className="grid place-items-center py-4 text-white/40">
            <Loader2 className="animate-spin" size={16} />
          </div>
        )}
        {!loading && next && (
          <button
            className="mono mt-1 w-full rounded-lg py-2 text-[10px] uppercase tracking-wider text-white/45 transition hover:bg-white/5 hover:text-white"
            onClick={() => void load(applied, folder.id, next)}
          >
            Load more
          </button>
        )}
      </div>

      {open && (
        <PreviewModal
          preview={preview}
          loading={open.text === undefined && !open.error}
          error={open.error}
          footerNote="Docs, Sheets and Slides are exported as text; PDFs are read on this PC."
          onAttach={() => {
            if (open.text !== undefined) attach(open.file, open.text);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
