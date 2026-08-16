// Catalog of the web-compatible Gemma 4 variants exposed by the LiteRT-LM JS API.
// E2B is the lightweight default; E4B is the heavier, higher-quality option the
// user can opt into from Settings.

export type ModelId = 'gemma-4-E2B' | 'gemma-4-E4B';

export interface ModelSpec {
  id: ModelId;
  label: string; // shown in the status pill, e.g. "gemma-4-E2B"
  file: string; // .litertlm filename
  url: string; // Hugging Face resolve URL
  approxSizeGB: number;
  description: string;
  default?: boolean;
}

// Verified against the litert-community org (June 2026): the web-optimized
// `.litertlm` files live inside the `*-it-litert-lm` repos. These Gemma repos are
// GATED on Hugging Face — an unauthenticated browser fetch returns HTTP 401, so
// the "Download" button only works if the user is logged in / has accepted the
// license. The "local file" path is the reliable, fully-offline alternative.
const HF = 'https://huggingface.co/litert-community';

export const MODELS: Record<ModelId, ModelSpec> = {
  'gemma-4-E2B': {
    id: 'gemma-4-E2B',
    label: 'gemma-4-E2B',
    file: 'gemma-4-E2B-it-web.litertlm',
    url: `${HF}/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm`,
    approxSizeGB: 2.0,
    description: 'Lightweight, fastest to load. Recommended default.',
    default: true,
  },
  'gemma-4-E4B': {
    id: 'gemma-4-E4B',
    label: 'gemma-4-E4B',
    file: 'gemma-4-E4B-it-web.litertlm',
    url: `${HF}/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm`,
    approxSizeGB: 3.1,
    description: 'Higher quality, larger download and more GPU memory.',
  },
};

export const DEFAULT_MODEL_ID: ModelId = 'gemma-4-E2B';

export const MODEL_LIST: ModelSpec[] = Object.values(MODELS);
