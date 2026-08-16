// Model file management for the desktop build.
//
// This replaces the browser build's OPFS cache. There, a ~2 GB .litertlm had to
// be copied byte-for-byte into origin-private storage before it could be used —
// a long wait and a permanent duplicate of a file the user already had. Here we
// only remember the *path*, and stream the file off disk on demand:
//
//   linkedModel(spec)             -> the registered file, or null
//   browseForModel(spec)          -> native picker, validates + registers
//   downloadModel(spec, onProg)   -> streams Hugging Face -> userData -> registers
//   openModelStream(spec, onProg) -> ReadableStream fed straight to the engine
//   unlinkModel(spec)
//
// Validation (the "LITERTLM" magic + minimum size) happens in the main process,
// which can check the first 8 bytes without reading the whole file.

import { requireDesktop, type LinkedModel } from './desktop';
import type { ModelSpec } from './models';

export type { LinkedModel };

export interface LoadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  ratio: number | null; // 0..1, or null when the total is unknown
}

export function linkedModel(spec: ModelSpec): Promise<LinkedModel | null> {
  return requireDesktop().linkedModel(spec.id);
}

export function browseForModel(spec: ModelSpec): Promise<LinkedModel | null> {
  return requireDesktop().browseModel(spec.id);
}

export function unlinkModel(spec: ModelSpec): Promise<void> {
  return requireDesktop().unlinkModel(spec.id);
}

export function revealModel(spec: ModelSpec): Promise<void> {
  return requireDesktop().revealModel(spec.id);
}

/**
 * Download the model from Hugging Face. Unlike the browser build (which
 * buffered the whole response in memory), the main process streams it directly
 * to a .part file and renames on success, so a cancel leaves nothing behind.
 */
export async function downloadModel(
  spec: ModelSpec,
  onProgress?: (p: LoadProgress) => void,
): Promise<LinkedModel> {
  const bridge = requireDesktop();
  const off = onProgress
    ? bridge.onDownloadProgress((tick) => {
        if (tick.modelId !== spec.id) return;
        onProgress({
          receivedBytes: tick.received,
          totalBytes: tick.total,
          ratio: tick.total ? tick.received / tick.total : null,
        });
      })
    : () => {};
  try {
    return await bridge.downloadModel(spec.id, spec.url, spec.file);
  } finally {
    off();
  }
}

export function cancelDownload(): Promise<void> {
  return requireDesktop().cancelDownload();
}

/**
 * Open the linked model file as a stream for `Engine.create`.
 *
 * The engine consumes a `ReadableStream<Uint8Array>`, so the bytes flow
 * disk -> main process -> wasm heap without ever materialising as a Blob. The
 * pass-through transform only counts bytes for the progress bar.
 */
export async function openModelStream(
  spec: ModelSpec,
  onProgress?: (p: LoadProgress) => void,
): Promise<ReadableStream<Uint8Array>> {
  const bridge = requireDesktop();
  const res = await fetch(bridge.modelStreamUrl(spec.id), { cache: 'no-store' });
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
