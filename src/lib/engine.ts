// Thin wrapper around @litert-lm/core. Centralizes Engine/Conversation lifecycle
// so the React layer never touches the raw SDK. Text-in / text-out only.
//
// API notes (verified against @litert-lm/core@0.13.1 type defs + source):
//  - EngineSettings.model is `string | ReadableStream<Uint8Array>` — NOT a Blob.
//    The desktop build passes a stream straight off disk (see modelStore.ts), so
//    the ~2 GB file is never materialised in renderer memory.
//  - Sampler temperature lives in ConversationConfig.sessionConfig.samplerParams.
//  - sendMessageStreaming() returns a ReadableStream<Message>, not an async
//    iterable; we read it with a reader.
//  - Message.content is `string | { text?: string }[]`.

import type { Conversation, Engine, Message } from '@litert-lm/core';
import { ControlTokenFilter } from './controlTokens';

// LiteRT-LM's default wasm path is a jsDelivr URL
// (LiteRtLm.DEFAULT_WASM_PATH = https://cdn.jsdelivr.net/npm/@litert-lm/core@…/wasm).
// A desktop app must not reach out to a CDN to start its inference runtime — and
// the app's CSP forbids it — so we preload the ~19 MB wasm that
// scripts/vendor-assets.mjs copied into public/litertlm/.
const WASM_DIR = new URL('litertlm/', document.baseURI).href;

/** Top-K ceiling the GPU sampler is built for (the Settings slider goes to 128). */
const MAX_TOP_K = 128;

type Core = typeof import('@litert-lm/core');

let corePromise: Promise<Core> | null = null;
let wasmReady: Promise<unknown> | null = null;

/** The SDK module. Kept lazy so its large wasm assets load on first use. */
function loadCore(): Promise<Core> {
  corePromise ??= import('@litert-lm/core');
  return corePromise;
}

/** Load the local wasm runtime once per session (loadLiteRtLm throws if called twice). */
function ensureWasmRuntime(): Promise<unknown> {
  wasmReady ??= loadCore().then(({ loadLiteRtLm }) => loadLiteRtLm(WASM_DIR));
  return wasmReady;
}

export interface EngineConfig {
  temperature: number;
  /** Top-K cutoff. Gemma's reference sampling settings use 64. */
  topK: number;
  /** Nucleus cutoff. Gemma's reference sampling settings use 0.95. */
  topP: number;
  /** Context window the executor allocates a KV cache for. */
  maxNumTokens: number;
  /** Hard cap on a single reply, so a degenerate loop cannot run to the context limit. */
  maxOutputTokens: number;
  systemPrompt: string;
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

function messageText(msg: Message): string {
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => item?.text ?? '').join('');
  }
  return '';
}

export class LlmEngine {
  private engine: Engine | null = null;
  /** Top-K the engine's sampler accepts; sessions are clamped to it. */
  private maxTopK = MAX_TOP_K;
  private conversation: Conversation | null = null;
  private oneShot: Conversation | null = null;
  private generating = false;

  constructor(
    private readonly label: string,
    private config: EngineConfig,
  ) {}

  get modelLabel(): string {
    return this.label;
  }

  /**
   * Full sampler configuration for a session.
   *
   * `type` matters as much as `temperature`: SamplerParameters defaults to
   * TYPE_UNSPECIFIED with k = p = 0, which decodes greedily and ignores the
   * temperature entirely — the classic route to a reply that degenerates into
   * repeating the same token forever. Setting TOP_P with Gemma's reference
   * k/p is what makes `temperature` take effect at all.
   */
  private async samplerParams() {
    const { SamplerType } = await loadCore();
    return {
      type: SamplerType.TOP_P,
      k: Math.max(1, Math.min(this.config.topK, this.maxTopK)),
      p: this.config.topP,
      temperature: this.config.temperature,
    };
  }

  /**
   * Load the model into a WebGPU-backed engine and open an empty conversation.
   * `model` streams from the user's .litertlm file via the app:// handler.
   */
  async init(model: ReadableStream<Uint8Array>): Promise<void> {
    await ensureWasmRuntime();
    const { Engine } = await loadCore();
    this.engine = await Engine.create({
      model,
      mainExecutorSettings: {
        maxNumTokens: this.config.maxNumTokens,
        // The default GPU_ARTISAN backend compiles its sampler for
        // max_top_k = 1, and every session asking for more is rejected with
        // "Top-K value N must be <= 1" — so sampling with a real top-K (which
        // is what keeps decoding out of greedy repetition loops) needs the
        // limit raised when the engine is created. The other fields are the
        // runtime's own defaults, read back from a live engine's settings; the
        // SDK requires the whole object, not a patch.
        backendConfig: {
          num_output_candidates: 1,
          wait_for_weight_uploads: false,
          num_decode_steps_per_sync: 1,
          sequence_batch_size: 0,
          supported_lora_ranks: [],
          max_top_k: MAX_TOP_K,
          enable_decode_logits: false,
          enable_external_embeddings: false,
          use_submodel: false,
        },
      },
    });
    // Whatever the runtime actually accepted is the ceiling for sessions.
    const effective = (this.engine as unknown as { settings?: { mainExecutorSettings?: { backendConfig?: { max_top_k?: number } } } })
      .settings?.mainExecutorSettings?.backendConfig?.max_top_k;
    this.maxTopK = typeof effective === 'number' && effective > 0 ? effective : MAX_TOP_K;
    if (this.maxTopK < this.config.topK) {
      console.warn(`[engine] runtime caps top-K at ${this.maxTopK}; requested ${this.config.topK} will be clamped`);
    }
    await this.openConversation([]);
  }

  /**
   * (Re)open the active conversation, optionally seeded with prior turns so the
   * model has context when resuming a saved chat. Also used to apply a changed
   * temperature / system prompt (both are fixed at conversation creation).
   */
  async openConversation(history: HistoryTurn[]): Promise<void> {
    if (!this.engine) throw new Error('Engine not initialized');
    const messages: { role: string; content: string }[] = [];
    const sys = this.config.systemPrompt.trim();
    if (sys) messages.push({ role: 'system', content: sys });
    for (const t of history) {
      if (t.content.trim()) messages.push({ role: t.role, content: t.content });
    }
    await this.conversation?.delete().catch(() => {});
    this.conversation = await this.engine.createConversation({
      preface: messages.length ? { messages } : undefined,
      sessionConfig: {
        samplerParams: await this.samplerParams(),
        maxOutputTokens: this.config.maxOutputTokens,
      },
    });
  }

  /** Update settings in memory. Call openConversation() afterwards to apply
   *  temperature / system prompt to a (re)created conversation. */
  updateConfig(next: Partial<EngineConfig>): void {
    this.config = { ...this.config, ...next };
  }

  get isGenerating(): boolean {
    return this.generating;
  }

  private async *stream(
    conversation: Conversation,
    prompt: string,
  ): AsyncGenerator<string> {
    const reader = conversation.sendMessageStreaming(prompt).getReader();
    // The runtime leaks vocabulary control tokens into the decoded text; strip
    // them before anything reaches the UI. Stateful because a token can be split
    // across two reads — see controlTokens.ts.
    const filter = new ControlTokenFilter();
    this.generating = true;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = filter.push(messageText(value));
        if (text) yield text;
      }
      const tail = filter.flush();
      if (tail) yield tail;
    } finally {
      this.generating = false;
      reader.releaseLock();
    }
  }

  /** Stream a reply in the main chat conversation. */
  async *send(prompt: string): AsyncGenerator<string> {
    if (!this.conversation) throw new Error('No active conversation');
    yield* this.stream(this.conversation, prompt);
  }

  /**
   * One-shot generation in a fresh, throwaway conversation. Used by tools
   * (PDF, RAG, …) so their context doesn't leak into the main chat history.
   */
  async *generate(
    prompt: string,
    systemPrompt?: string,
  ): AsyncGenerator<string> {
    if (!this.engine) throw new Error('Engine not initialized');
    const preface = systemPrompt?.trim()
      ? { messages: [{ role: 'system', content: systemPrompt.trim() }] }
      : undefined;
    this.oneShot = await this.engine.createConversation({
      preface,
      sessionConfig: {
        samplerParams: await this.samplerParams(),
        maxOutputTokens: this.config.maxOutputTokens,
      },
    });
    try {
      yield* this.stream(this.oneShot, prompt);
    } finally {
      await this.oneShot?.delete().catch(() => {});
      this.oneShot = null;
    }
  }

  /**
   * Generate from an explicit message list, in a throwaway conversation.
   *
   * The chat path lets the LiteRT-LM Conversation keep history internally,
   * which leaves nothing to trim or compact. The agent loop instead owns its
   * message list and rebuilds the model's context from it every round — as
   * Odysseus re-sends `messages` to the API each round — so context management
   * is entirely in the loop's hands. Everything but the final message becomes
   * the preface; the final (user-role) message is the prompt.
   */
  async *generateFrom(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): AsyncGenerator<string> {
    if (!this.engine) throw new Error('Engine not initialized');
    if (!messages.length) return;
    const last = messages[messages.length - 1];
    const preface = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
    this.oneShot = await this.engine.createConversation({
      preface: preface.length ? { messages: preface } : undefined,
      sessionConfig: {
        samplerParams: await this.samplerParams(),
        maxOutputTokens: this.config.maxOutputTokens,
      },
    });
    try {
      yield* this.stream(this.oneShot, last.content);
    } finally {
      await this.oneShot?.delete().catch(() => {});
      this.oneShot = null;
    }
  }

  cancel(): void {
    this.conversation?.cancel();
    this.oneShot?.cancel();
    this.generating = false;
  }

  async dispose(): Promise<void> {
    try {
      this.cancel();
      await this.conversation?.delete().catch(() => {});
      await this.engine?.delete();
    } finally {
      this.engine = null;
      this.conversation = null;
    }
  }
}
