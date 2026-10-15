// Word documents, rendered with docx-preview.
//
// Read-only, deliberately. docx-preview renders a .docx faithfully — styles,
// tables, numbering, headers — but it does not write. Editing the HTML it
// produces and saving it back would be a different document: an HTML round
// trip loses the parts of OOXML that have no HTML equivalent. So this shows
// the document and says plainly that it cannot be edited here yet.

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { officeApi } from '../../lib/office/api';
import { cleanError } from '../../lib/desktop';

export default function WordViewer({ file, legacy }: { file: string; legacy: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (legacy) {
      setLoading(false);
      setError(
        'This is a pre-2007 .doc file, which is a different binary format. Open it in Word and save as .docx to view it here.',
      );
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const [{ renderAsync }, bytes] = await Promise.all([import('docx-preview'), officeApi.readBytes(file)]);
        if (cancelled || !host.current) return;
        host.current.innerHTML = '';
        await renderAsync(new Blob([new Uint8Array(bytes)]), host.current, undefined, {
          className: 'docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true,
          breakPages: true,
          experimental: true,
digitalSignatures: false,
        } as Parameters<typeof renderAsync>[3]);
      } catch (err) {
        if (!cancelled) setError(cleanError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, legacy]);

  return (
    <div className="relative h-full overflow-auto bg-[#2a2733]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-white/50">
          <Loader2 className="animate-spin" size={18} /> Rendering the document…
        </div>
      )}
      {error && (
        <div className="flex h-full items-center justify-center px-10">
          <p className="max-w-lg text-center text-sm text-red-300">{error}</p>
        </div>
      )}
      <div ref={host} className="ms-docx-host" />
    </div>
  );
}
