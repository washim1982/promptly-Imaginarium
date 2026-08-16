// In-browser PDF text extraction via pdf.js. Nothing is uploaded — the file is
// read as an ArrayBuffer and parsed locally, then fed to the local Gemma model.

import * as pdfjs from 'pdfjs-dist';
// Let Vite bundle + instantiate the worker. This avoids pdf.js fetching the
// worker by URL (which broke under strict MIME / the module "fake worker"
// fallback) and emits a .js chunk that's served with the correct MIME type.
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

// workerPort uses a worker we own; pdf.js won't terminate it, so it's safe to
// reuse across multiple documents.
pdfjs.GlobalWorkerOptions.workerPort = new PdfjsWorker();

export interface PdfDoc {
  name: string;
  numPages: number;
  text: string;
  chars: number;
}

export async function extractPdfText(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<PdfDoc> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const parts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    parts.push(pageText);
    onProgress?.(i, pdf.numPages);
  }

  const text = parts.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  return { name: file.name, numPages: pdf.numPages, text, chars: text.length };
}

// OCR fallback for scanned / image-only PDFs (no embedded text layer).
// Renders each page to a canvas and recognizes text with Tesseract.js.
//
// Unlike the web build, every piece is local: the worker, the wasm core, and the
// English language data all ship in public/tesseract (see
// scripts/vendor-assets.mjs). A desktop app can't depend on a CDN, and the
// renderer's CSP blocks one anyway.
const TESS_BASE = new URL('tesseract/', document.baseURI).href;

export async function ocrPdf(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<PdfDoc> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;

  // Lazy-load Tesseract only when OCR is actually needed.
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    workerPath: `${TESS_BASE}worker.min.js`,
    corePath: `${TESS_BASE}core`,
    langPath: TESS_BASE,
  });

  const parts: string[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 }); // upscale for OCR accuracy
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');
      await page.render({ canvasContext: ctx, viewport }).promise;

      const {
        data: { text },
      } = await worker.recognize(canvas);
      parts.push(text);
      onProgress?.(i, pdf.numPages);

      canvas.width = 0; // release memory
      canvas.height = 0;
    }
  } finally {
    await worker.terminate();
  }

  const text = parts.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  return { name: file.name, numPages: pdf.numPages, text, chars: text.length };
}

// Gemma E2B runs with an 8K-token window; keep a conservative character budget
// (~4 chars/token) so the document + instructions fit. Returns the (possibly
// truncated) context plus a flag.
const CHAR_BUDGET = 18_000;

export function clampForContext(text: string): {
  context: string;
  truncated: boolean;
} {
  if (text.length <= CHAR_BUDGET) return { context: text, truncated: false };
  return { context: text.slice(0, CHAR_BUDGET), truncated: true };
}
