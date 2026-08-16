import { useRef, useState } from 'react';
import { useLlm } from '../state/LlmContext';
import { clampForContext, extractPdfText, ocrPdf, type PdfDoc } from '../lib/pdf';
import ModelLoader from '../components/chat/ModelLoader';

type Phase = 'empty' | 'parsing' | 'ocr' | 'ready';

export default function PdfTools() {
  const { status, generate, cancel, gpu } = useLlm();
  const [phase, setPhase] = useState<Phase>('empty');
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [parseProgress, setParseProgress] = useState<[number, number] | null>(
    null,
  );
  const [parseError, setParseError] = useState<string | null>(null);
  const [ocrUsed, setOcrUsed] = useState(false);

  const [question, setQuestion] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ---- Gates -------------------------------------------------------------
  if (status === 'checking-gpu') {
    return (
      <Wrap>
        <p className="mono text-sm text-white/50">Checking GPU support…</p>
      </Wrap>
    );
  }
  if (status !== 'ready') {
    return (
      <Wrap>
        <p className="mb-6 text-center text-sm text-white/55">
          Load a model to use PDF Tools — everything runs locally.
        </p>
        <ModelLoader />
        {gpu?.adapter && (
          <p className="mono mt-4 text-[10px] text-white/30">
            GPU: {gpu.adapter}
          </p>
        )}
      </Wrap>
    );
  }

  // ---- Handlers ----------------------------------------------------------
  async function onFile(file: File) {
    setParseError(null);
    setOutput('');
    setDoc(null);
    setOcrUsed(false);
    setPhase('parsing');
    setParseProgress([0, 0]);
    try {
      // 1. Try the embedded text layer (fast).
      let result = await extractPdfText(file, (p, t) => setParseProgress([p, t]));

      // 2. No text layer -> scanned/image PDF -> OCR fallback.
      if (!result.text.trim()) {
        setOcrUsed(true);
        setPhase('ocr');
        setParseProgress([0, 0]);
        result = await ocrPdf(file, (p, t) => setParseProgress([p, t]));
      }

      if (!result.text.trim()) {
        throw new Error(
          'No text could be extracted, even with OCR. The scan may be too low quality.',
        );
      }
      setDoc(result);
      setPhase('ready');
    } catch (err) {
      setParseError((err as Error).message);
      setPhase('empty');
    }
  }

  async function run(prompt: string, system: string) {
    if (!doc || busy) return;
    setBusy(true);
    setOutput('');
    try {
      for await (const token of generate(prompt, system)) {
        setOutput((o) => o + token);
      }
    } catch (err) {
      setOutput((o) => o + `\n\n[error: ${(err as Error).message}]`);
    } finally {
      setBusy(false);
    }
  }

  function summarize() {
    if (!doc) return;
    const { context, truncated } = clampForContext(doc.text);
    run(
      `Summarize the following document in clear bullet points, then give a one-sentence takeaway.${
        truncated ? ' (Note: the document was truncated to fit the context.)' : ''
      }\n\n---\n${context}`,
      'You are a precise document analyst. Be concise and faithful to the source.',
    );
  }

  function ask() {
    if (!doc || !question.trim()) return;
    const { context } = clampForContext(doc.text);
    run(
      `Using only the document below, answer the question. If the answer is not in the document, say so.\n\nDocument:\n${context}\n\nQuestion: ${question.trim()}`,
      'You answer strictly from the provided document and never invent facts.',
    );
  }

  // ---- UI ----------------------------------------------------------------
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">PDF Tools</h1>
        <p className="text-sm text-white/45">
          Summarize and query PDFs entirely on-device — text or scanned (OCR).
          No file leaves your browser.
        </p>
      </div>

      {/* Upload / document card */}
      {phase !== 'ready' ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
          className="glass flex flex-col items-center justify-center rounded-[var(--radius-panel)] border border-dashed border-white/15 p-10 text-center"
        >
          {phase === 'parsing' || phase === 'ocr' ? (
            <div className="text-center">
              <p className="mono text-sm text-white/60">
                {phase === 'ocr' ? 'Running OCR (scanned PDF)' : 'Extracting text'}
                {parseProgress && parseProgress[1]
                  ? ` · page ${parseProgress[0]}/${parseProgress[1]}`
                  : '…'}
              </p>
              {phase === 'ocr' && (
                <p className="mono mt-1 text-[10px] text-white/35">
                  No text layer found — reading the image. This can take a while.
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="mb-3 text-3xl">📄</div>
              <p className="text-sm text-white/70">
                Drop a PDF here, or
              </p>
              <button
                onClick={() => fileRef.current?.click()}
                className="neon-glow mt-3 rounded-xl bg-[var(--color-neon)] px-4 py-2 text-sm font-semibold text-black hover:brightness-110"
              >
                Choose a PDF
              </button>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />
        </div>
      ) : (
        doc && (
          <div className="glass flex items-center justify-between rounded-2xl p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">
                {doc.name}
              </p>
              <p className="mono mt-0.5 text-[10px] text-white/40">
                {doc.numPages} pages · {doc.chars.toLocaleString()} chars
                {ocrUsed && ' · OCR'}
                {doc.chars > 18000 && ' · truncated for context'}
              </p>
            </div>
            <button
              onClick={() => {
                setPhase('empty');
                setDoc(null);
                setOutput('');
              }}
              className="mono shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-[10px] text-white/60 hover:bg-white/5"
            >
              Replace
            </button>
          </div>
        )
      )}

      {parseError && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {parseError}
        </p>
      )}

      {/* Actions */}
      {phase === 'ready' && (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={summarize}
              disabled={busy}
              className="glass rounded-xl px-4 py-2 text-sm text-white hover:bg-white/10 disabled:opacity-40"
            >
              Summarize
            </button>
            {busy && (
              <button
                onClick={() => {
                  cancel();
                  setBusy(false);
                }}
                className="rounded-xl bg-red-500/80 px-4 py-2 text-sm text-white hover:bg-red-500"
              >
                Stop
              </button>
            )}
          </div>

          <div className="glass flex items-end gap-2 rounded-2xl px-4 py-3">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) ask();
              }}
              placeholder="Ask a question about this PDF…"
              className="flex-1 bg-transparent text-sm text-white placeholder:text-white/35 focus:outline-none"
            />
            <button
              onClick={ask}
              disabled={busy || !question.trim()}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20 disabled:opacity-30"
            >
              Ask
            </button>
          </div>

          {(output || busy) && (
            <div className="glass min-h-[120px] whitespace-pre-wrap rounded-2xl p-4 text-[15px] leading-relaxed text-white/90">
              {output}
              {busy && (
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--color-neon)] align-middle" />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      {children}
    </div>
  );
}
