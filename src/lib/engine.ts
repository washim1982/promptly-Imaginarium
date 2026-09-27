
import type { Conversation, Engine, Message } from '@litert-lm/core';
import { ControlTokenFilter } from './controlTokens';

const WASM_DIR = new URL('litertlm/', document.baseURI).href;

const MAX_TOP_K = 128;

type Core = typeof import('@litert-lm/core');

let corePromise: Promise<Core> | null = null;
let wasmReady: Promise<unknown> | null = null;

function loadCore(): Promise<Core> {
  corePromise ??= import('@litert-lm/core');
  return corePromise;
}

function ensureWasmRuntime(): Promise<unknown> {
  wasmReady ??= loadCore().then(({ loadLiteRtLm }) => loadLiteRtLm(WASM_DIR));
  return wasmReady;
}

export interface EngineConfig {
  temperature: number;
  topK: number;
  topP: number;
  maxNumTokens: number;
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

  private async samplerParams() {
    const { SamplerType } = await loadCore();
    return {
      type: SamplerType.TOP_P,
      k: Math.max(1, Math.min(this.config.topK, this.maxTopK)),
      p: this.config.topP,
      temperature: this.config.temperature,
    };
  }

  async init(model: ReadableStream<Uint8Array>): Promise<void> {
    await ensureWasmRuntime();
    const { Engine } = await loadCore();
    this.engine = await Engine.create({
      model,
      mainExecutorSettings: {
        maxNumTokens: this.config.maxNumTokens,
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
    const effective = (this.engine as unknown as { settings?: { mainExecutorSettings?: { backendConfig?: { max_top_k?: number } } } })
      .settings?.mainExecutorSettings?.backendConfig?.max_top_k;
    this.maxTopK = typeof effective === 'number' && effective > 0 ? effective : MAX_TOP_K;
    if (this.maxTopK < this.config.topK) {
      console.warn(`[engine] runtime caps top-K at ${this.maxTopK}; requested ${this.config.topK} will be clamped`);
    }
    await this.openConversation([]);
  }

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

  async *send(prompt: string): AsyncGenerator<string> {
    if (!this.conversation) throw new Error('No active conversation');
    yield* this.stream(this.conversation, prompt);
  }

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
