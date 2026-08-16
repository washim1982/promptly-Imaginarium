// The model library, from the renderer's side.
//
// This replaces the browser build's OPFS cache. There, a ~2 GB .litertlm had to
// be copied byte-for-byte into origin-private storage before it could be used,
// which is why that build could only justify two fixed model slots. Here the app
// only remembers paths, so the library is open-ended — any .litertlm the user
// browses to is a first-class model — and the file is streamed off disk:
//
//   listModels()                  -> everything in the library
//   addModels()                   -> native multi-select picker, validates each
//   removeModel / renameModel / revealModel
//   downloadModel(url, file, cb)  -> Hugging Face -> userData -> library entry
//   openModelStream(entry, cb)    -> ReadableStream fed straight to the engine
//
// Validation (the "LITERTLM" magic + a minimum size) happens in the main
// process, which can check the first 8 bytes without reading the whole file.

import { requireDesktop } from './desktop';
import type { AddResult, ModelEntry } from './models';

export interface LoadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  ratio: number | null; // 0..1, or null when the total is unknown
}

export function listModels(): Promise<ModelEntry[]> {
  return requireDesktop().listModels();
}

export function getModel(id: string): Promise<ModelEntry | null> {
  return requireDesktop().getModel(id);
}

/** Open the native picker. Returns what was added and what was rejected. */
export function addModels(): Promise<AddResult> {
  return requireDesktop().addModels();
}

export function removeModel(id: string): Promise<void> {
  return requireDesktop().removeModel(id);
}

export function renameModel(id: string, label: string): Promise<ModelEntry | null> {
  return requireDesktop().renameModel(id, label);
}

export function revealModel(id: string): Promise<void> {
  return requireDesktop().revealModel(id);
}

/**
 * Download a suggested model from Hugging Face. Unlike the browser build (which
 * buffered the whole response in memory), the main process streams it directly
 * to a .part file and renames on success, so a cancel leaves nothing behind.
 * The result is an ordinary library entry.
 */
export async function downloadModel(
  url: string,
  fileName: string,
  onProgress?: (p: LoadProgress) => void,
): Promise<ModelEntry> {
  const bridge = requireDesktop();
  const off = onProgress
    ? bridge.onDownloadProgress((tick) =>
        onProgress({
          receivedBytes: tick.received,
          totalBytes: tick.total,
          ratio: tick.total ? tick.received / tick.total : null,
        }),
      )
    : () => {};
  try {
    return await bridge.downloadModel(url, fileName);
  } finally {
    off();
  }
}

export function cancelDownload(): Promise<void> {
  return requireDesktop().cancelDownload();
}

/**
 * Open a library model as a stream for `Engine.create`.
 *
 * The engine consumes a `ReadableStream<Uint8Array>`, so the bytes flow
 * disk -> main process -> wasm heap without ever materialising as a Blob. The
 * pass-through transform only counts bytes for the progress bar.
 */
export async function openModelStream(
  id: string,
  onProgress?: (p: LoadProgress) => void,
): Promise<ReadableStream<Uint8Array>> {
  const bridge = requireDesktop();
  const res = await fetch(bridge.modelStreamUrl(id), { cache: 'no-store' });
  if (!res.ok || !res.body) {
    throw new Error(
      (await res.text().catch(() => '')) ||
        `Could not read the model file (HTTP ${res.status}).`,
    );
  }

  if (!onProgress) return res.body;

  const totalHeader = res.headers.get('content-length');
  const totalBytes = totalHeader ? Number(totalHeader) : null;
  let received = 0;

  return res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        onProgress({
          receivedBytes: received,
          totalBytes,
          ratio: totalBytes ? received / totalBytes : null,
        });
        controller.enqueue(chunk);
      },
    }),
  );
}
