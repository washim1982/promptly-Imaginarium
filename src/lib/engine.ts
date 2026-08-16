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

let wasmReady: Promise<unknown> | null = null;

/** Load the local wasm runtime once per session (loadLiteRtLm throws if called twice). */
function ensureWasmRuntime(): Promise<unknown> {
  wasmReady ??= import('@litert-lm/core').then(({ loadLiteRtLm }) =>
    loadLiteRtLm(WASM_DIR),
  );
  return wasmReady;
}

export interface EngineConfig {
  temperature: number;
  maxNumTokens: number;
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
   * Load the model into a WebGPU-backed engine and open an empty conversation.
   * `model` streams from the user's .litertlm file via the app:// handler.
   */
  async init(model: ReadableStream<Uint8Array>): Promise<void> {
    await ensureWasmRuntime();
    const { Engine } = await import('@litert-lm/core');
    this.engine = await Engine.create({
      model,
      mainExecutorSettings: { maxNumTokens: this.config.maxNumTokens },
    });
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
        samplerParams: { temperature: this.config.temperature },
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
        samplerParams: { temperature: this.config.temperature },
      },
    });
    try {
      yield* this.stream(this.oneShot, prompt);
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
