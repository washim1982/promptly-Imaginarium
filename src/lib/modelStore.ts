
import { requireDesktop } from './desktop';
import type { AddResult, ModelEntry } from './models';

export interface LoadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  ratio: number | null;
}

export function listModels(): Promise<ModelEntry[]> {
  return requireDesktop().listModels();
}

export function getModel(id: string): Promise<ModelEntry | null> {
  return requireDesktop().getModel(id);
}

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
