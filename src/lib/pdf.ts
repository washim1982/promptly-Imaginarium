
import * as pdfjs from 'pdfjs-dist';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

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

const TESS_BASE = new URL('tesseract/', document.baseURI).href;

export async function ocrPdf(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<PdfDoc> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;

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
      const viewport = page.getViewport({ scale: 2 });
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

      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await worker.terminate();
  }

  const text = parts.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  return { name: file.name, numPages: pdf.numPages, text, chars: text.length };
}

const CHAR_BUDGET = 18_000;

export function clampForContext(text: string): {
  context: string;
  truncated: boolean;
} {
  if (text.length <= CHAR_BUDGET) return { context: text, truncated: false };
  return { context: text.slice(0, CHAR_BUDGET), truncated: true };
}
