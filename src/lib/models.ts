// The model library.
//
// The web build shipped two hard-coded slots (gemma-4-E2B / E4B) because a
// browser could only reasonably cache one or two multi-GB blobs in OPFS. On the
// desktop there is no such limit: the app just remembers file paths, so it holds
// an open-ended library and any .litertlm file can be added by browsing to it.
//
// A ModelEntry is created by the main process (which owns models.json) — the
// renderer never invents one.

export interface ModelEntry {
  /** Generated uuid. Stable across renames and used in the app://model/<id> URL. */
  id: string;
  /** Display name. Defaults to the filename; the user can rename it. */
  label: string;
  /** Absolute path. The file stays wherever the user put it. */
  path: string;
  /** Basename of `path`, kept so the UI can show the real filename after a rename. */
  name: string;
  size: number;
  /** True if this app downloaded the file itself, so it may also delete it. */
  managed: boolean;
  addedAt: number;
  lastUsedAt: number | null;
}

/** A file that failed validation during a multi-file add. */
export interface RejectedModel {
  name: string;
  reason: string;
}

export interface AddResult {
  added: ModelEntry[];
  rejected: RejectedModel[];
}

/**
 * Optional one-click downloads. These are *shortcuts*, not slots — picking one
 * produces an ordinary library entry, exactly like browsing to a file. Both
 * repos are gated on Hugging Face, so an unauthenticated fetch returns a login
 * page; the browse path is the reliable one.
 */
export interface ModelSuggestion {
  label: string;
  file: string;
  url: string;
  approxSizeGB: number;
  description: string;
}

const HF = 'https://huggingface.co/litert-community';

export const SUGGESTED_MODELS: ModelSuggestion[] = [
  {
    label: 'gemma-4-E2B',
    file: 'gemma-4-E2B-it-web.litertlm',
    url: `${HF}/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm`,
    approxSizeGB: 2.0,
    description: 'Lightweight, fastest to load.',
  },
  {
    label: 'gemma-4-E4B',
    file: 'gemma-4-E4B-it-web.litertlm',
    url: `${HF}/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm`,
    approxSizeGB: 3.1,
    description: 'Higher quality, larger download and more GPU memory.',
  },
];

/** Repo page for a suggestion (strip the /resolve/... file part). */
export function repoUrl(s: ModelSuggestion): string {
  return s.url.replace(/\/resolve\/.+$/, '');
}

/** Default display name for a file: its basename without the .litertlm suffix. */
export function labelFromFileName(fileName: string): string {
  return fileName.replace(/\.litertlm$/i, '') || fileName;
}

/** Newest-used first, then most recently added — the order the UI lists them in. */
export function sortModels(models: ModelEntry[]): ModelEntry[] {
  return [...models].sort(
    (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.addedAt - a.addedAt,
  );
}
