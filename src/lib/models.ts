
export interface ModelEntry {
  id: string;
  label: string;
  path: string;
  name: string;
  size: number;
  managed: boolean;
  addedAt: number;
  lastUsedAt: number | null;
}

export interface RejectedModel {
  name: string;
  reason: string;
}

export interface AddResult {
  added: ModelEntry[];
  rejected: RejectedModel[];
}

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

export function repoUrl(s: ModelSuggestion): string {
  return s.url.replace(/\/resolve\/.+$/, '');
}

export function labelFromFileName(fileName: string): string {
  return fileName.replace(/\.litertlm$/i, '') || fileName;
}

export function sortModels(models: ModelEntry[]): ModelEntry[] {
  return [...models].sort(
    (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.addedAt - a.addedAt,
  );
}
