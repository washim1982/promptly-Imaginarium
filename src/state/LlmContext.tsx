import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { detectWebGPU, type GpuSupport } from '../lib/webgpu';
import { LlmEngine, type EngineConfig, type HistoryTurn } from '../lib/engine';
import {
  deleteConversation as dbDelete,
  exportConversations,
  getConversation,
  importConversations,
  listConversations,
  putConversation,
  type ConversationMeta,
} from '../lib/history';
import {
  addModels as pickModels,
  cancelDownload,
  downloadModel,
  listModels,
  openModelStream,
  removeModel as dropModel,
  renameModel as setModelLabel,
  type LoadProgress,
} from '../lib/modelStore';
import {
  sortModels,
  type AddResult,
  type ModelEntry,
  type ModelSuggestion,
} from '../lib/models';
import type { ChatWidth } from '../lib/ui';
import { DEFAULT_THEME_ID, resolveAccent } from '../lib/themes';
import { webSearch, formatSearchForChat, type SearchResult } from '../lib/search';
import { cleanError, isCancellation } from '../lib/desktop';
import { stripControlTokens } from '../lib/controlTokens';

export type EngineStatus =
  | 'checking-gpu'
  | 'unsupported'
  | 'idle' // GPU ok, no model loaded
  | 'downloading' // fetching from Hugging Face into userData
  | 'reading' // streaming the local .litertlm off disk into the engine
  | 'initializing'
  | 'ready'
  | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  streaming?: boolean;
  // Web-search-grounded replies: true while the search is running, plus the
  // sources the answer was grounded in (shown under the message).
  searching?: boolean;
  sources?: SearchResult[];
}

export type ModelSource =
  /** Load a model already in the library (defaults to the active one). */
  | { type: 'library'; id?: string }
  /** Open the native picker, add whatever is chosen, then load the first one. */
  | { type: 'add' }
  /** Download a suggested model, add it to the library, then load it. */
  | { type: 'download'; suggestion: ModelSuggestion };

interface LlmState {
  gpu: GpuSupport | null;
  status: EngineStatus;
  error: string | null;
  progress: LoadProgress | null;
  /** Every .litertlm the user has added, most-recently-used first. */
  models: ModelEntry[];
  activeModelId: string | null;
  /** The library entry currently selected, if any. */
  activeModel: ModelEntry | null;
  /** Files rejected by the last add, so the UI can explain why. */
  rejected: AddResult['rejected'];
  settings: EngineConfig;
  chatWidth: ChatWidth;
  theme: string;
  customGlow: string | null;
  messages: ChatMessage[];
  isGenerating: boolean;
  webSearchEnabled: boolean;
  // history
  conversations: ConversationMeta[];
  activeConversationId: string | null;
  // actions
  setChatWidth: (w: ChatWidth) => void;
  setTheme: (id: string) => void;
  setCustomGlow: (hex: string | null) => void;
  setActiveModel: (id: string) => void;
  setWebSearchEnabled: (on: boolean) => void;
  loadModel: (source: ModelSource) => Promise<void>;
  /** Open the native picker and add the chosen .litertlm files to the library. */
  addModels: () => Promise<AddResult>;
  /** Remove from the library. Downloaded copies are deleted; user files are not. */
  removeModel: (id: string) => Promise<void>;
  renameModel: (id: string, label: string) => Promise<void>;
  dismissRejected: () => void;
  updateSettings: (next: Partial<EngineConfig>) => Promise<void>;
  send: (text: string) => Promise<void>;
  /** One-shot streaming generation in an isolated conversation (for tools). */
  generate: (prompt: string, systemPrompt?: string) => AsyncGenerator<string>;
  cancel: () => void;
  // history actions
  newChat: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  exportHistory: () => Promise<void>;
  importHistory: (file: File) => Promise<void>;
}

// Gemma's reference sampling settings are temperature 1.0 / top-K 64 /
// top-P 0.95. Nudged slightly cooler for an assistant, but K and P are left at
// the reference values — they are what keep the sampler out of greedy mode.
const DEFAULT_SETTINGS: EngineConfig = {
  temperature: 0.75,
  topK: 64,
  topP: 0.95,
  maxNumTokens: 8192,
  maxOutputTokens: 2048,
  systemPrompt: 'You are Imaginarium, a helpful, concise assistant.',
};

const SETTINGS_KEY = 'imaginarium.settings';
const MODEL_KEY = 'imaginarium.activeModel';
const CHAT_WIDTH_KEY = 'imaginarium.chatWidth';
const THEME_KEY = 'imaginarium.theme';
const GLOW_KEY = 'imaginarium.customGlow';
const WEB_SEARCH_KEY = 'imaginarium.webSearch';

// Sources fed to the model per chat answer — kept small so the conversation
// context stays lean across turns.
const CHAT_SEARCH_MAX_SOURCES = 6;

function loadSettings(): EngineConfig {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Completed (non-streaming, non-empty) turns to seed the model on resume.
function messagesToTurns(msgs: ChatMessage[]): HistoryTurn[] {
  return msgs
    .filter((m) => m.text.trim())
    .map((m) => ({ role: m.role, content: m.text }));
}

function deriveTitle(msgs: ChatMessage[]): string {
  const firstUser = msgs.find((m) => m.role === 'user');
  const t = (firstUser?.text ?? '').trim().replace(/\s+/g, ' ');
  return t ? t.slice(0, 60) : 'New chat';
}

const LlmContext = createContext<LlmState | null>(null);

export function LlmProvider({ children }: { children: ReactNode }) {
  const [gpu, setGpu] = useState<GpuSupport | null>(null);
  const [status, setStatus] = useState<EngineStatus>('checking-gpu');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(
    localStorage.getItem(MODEL_KEY),
  );
  const [rejected, setRejected] = useState<AddResult['rejected']>([]);
  const [settings, setSettings] = useState<EngineConfig>(loadSettings);
  const [chatWidth, setChatWidthState] = useState<ChatWidth>(
    (localStorage.getItem(CHAT_WIDTH_KEY) as ChatWidth) || 'standard',
  );
  const [theme, setThemeState] = useState<string>(
    localStorage.getItem(THEME_KEY) || DEFAULT_THEME_ID,
  );
  const [customGlow, setCustomGlowState] = useState<string | null>(
    localStorage.getItem(GLOW_KEY) || null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [webSearchEnabled, setWebSearchEnabledState] = useState<boolean>(
    localStorage.getItem(WEB_SEARCH_KEY) === '1',
  );
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );

  const engineRef = useRef<LlmEngine | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeIdRef = useRef<string | null>(null);

  // Keep refs in sync so async callbacks read current values.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    activeIdRef.current = activeConversationId;
  }, [activeConversationId]);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      /* IndexedDB unavailable (e.g. private mode) — history just won't persist */
    }
  }, []);

  // Load the saved conversation list on startup.
  useEffect(() => {
    refreshConversations();
  }, [refreshConversations]);

  // Gate the app on WebGPU at startup.
  useEffect(() => {
    let active = true;
    detectWebGPU().then((support) => {
      if (!active) return;
      setGpu(support);
      setStatus(support.supported ? 'idle' : 'unsupported');
    });
    return () => {
      active = false;
    };
  }, []);

  // Persist settings & model selection.
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    if (activeModelId) localStorage.setItem(MODEL_KEY, activeModelId);
    else localStorage.removeItem(MODEL_KEY);
  }, [activeModelId]);
  useEffect(() => {
    localStorage.setItem(CHAT_WIDTH_KEY, chatWidth);
  }, [chatWidth]);
  useEffect(() => {
    localStorage.setItem(WEB_SEARCH_KEY, webSearchEnabled ? '1' : '0');
  }, [webSearchEnabled]);

  // Apply the visual theme: override --color-neon (and derive the soft variant)
  // on :root so glows, accents, and the ambient gradient all follow.
  useEffect(() => {
    const accent = resolveAccent(theme, customGlow);
    const root = document.documentElement;
    root.style.setProperty('--color-neon', accent);
    root.style.setProperty(
      '--color-neon-soft',
      `color-mix(in srgb, ${accent}, white 28%)`,
    );
    localStorage.setItem(THEME_KEY, theme);
    if (customGlow) localStorage.setItem(GLOW_KEY, customGlow);
    else localStorage.removeItem(GLOW_KEY);
  }, [theme, customGlow]);

  // Dispose engine on unmount / page unload.
  useEffect(() => {
    const onUnload = () => engineRef.current?.dispose();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      engineRef.current?.dispose();
    };
  }, []);

  /**
   * Re-read the library from the main process. It prunes entries whose files
   * have been moved or deleted, so this also keeps the active selection honest:
   * if the active model vanished, fall back to the first one left.
   */
  const refreshModels = useCallback(async (): Promise<ModelEntry[]> => {
    const list = sortModels(await listModels());
    setModels(list);
    setActiveModelId((current) => {
      if (current && list.some((m) => m.id === current)) return current;
      return list[0]?.id ?? null;
    });
    return list;
  }, []);

  useEffect(() => {
    void refreshModels().catch(() => setModels([]));
  }, [refreshModels]);

  const addModels = useCallback(async (): Promise<AddResult> => {
    const result = await pickModels();
    setRejected(result.rejected);
    if (result.added.length) {
      await refreshModels();
      // Select what was just added — it's almost certainly what the user wants.
      setActiveModelId(result.added[0].id);
    }
    return result;
  }, [refreshModels]);

  const removeModel = useCallback(
    async (id: string) => {
      await dropModel(id);
      // Unload the engine if the model backing it just left the library.
      if (id === activeModelId && status === 'ready') {
        await engineRef.current?.dispose();
        engineRef.current = null;
        setStatus('idle');
      }
      await refreshModels();
    },
    [activeModelId, status, refreshModels],
  );

  const renameModel = useCallback(
    async (id: string, label: string) => {
      await setModelLabel(id, label);
      await refreshModels();
    },
    [refreshModels],
  );

  const dismissRejected = useCallback(() => setRejected([]), []);

  const setActiveModel = useCallback((id: string) => {
    setActiveModelId(id);
  }, []);

  const activeModel = useMemo(
    () => models.find((m) => m.id === activeModelId) ?? null,
    [models, activeModelId],
  );

  const setWebSearchEnabled = useCallback((on: boolean) => {
    setWebSearchEnabledState(on);
  }, []);

  const setChatWidth = useCallback((w: ChatWidth) => {
    setChatWidthState(w);
  }, []);

  const setTheme = useCallback((id: string) => {
    setThemeState(id);
    setCustomGlowState(null); // choosing a preset clears the custom glow
  }, []);

  const setCustomGlow = useCallback((hex: string | null) => {
    setCustomGlowState(hex);
  }, []);

  const loadModel = useCallback(
    async (source: ModelSource) => {
      setError(null);
      try {
        // 1. Settle on a library entry to load.
        let entry: ModelEntry | undefined;
        if (source.type === 'add') {
          const result = await pickModels();
          setRejected(result.rejected);
          if (!result.added.length) {
            // Nothing usable was chosen. If everything was rejected the UI shows
            // why; if the dialog was cancelled, just stay put.
            await refreshModels();
            return;
          }
          entry = result.added[0];
        } else if (source.type === 'download') {
          setStatus('downloading');
          setProgress({ receivedBytes: 0, totalBytes: null, ratio: 0 });
          entry = await downloadModel(
            source.suggestion.url,
            source.suggestion.file,
            setProgress,
          );
        } else {
          const wanted = source.id ?? activeModelId;
          const list = await refreshModels();
          entry = list.find((m) => m.id === wanted) ?? undefined;
          if (!entry) {
            throw new Error(
              'That model is no longer available. Add a .litertlm file to get started.',
            );
          }
        }

        setActiveModelId(entry.id);
        if (source.type !== 'library') await refreshModels();

        // 2. Stream it into the WebGPU engine. Nothing is copied: the bytes go
        //    from disk through the app:// handler straight into the wasm heap.
        setStatus('reading');
        setProgress({ receivedBytes: 0, totalBytes: entry.size, ratio: 0 });
        const stream = await openModelStream(entry.id, setProgress);

        setStatus('initializing');
        await engineRef.current?.dispose();
        const engine = new LlmEngine(entry.label, settings);
        await engine.init(stream);
        engineRef.current = engine;
        setProgress(null);
        setStatus('ready');
      } catch (err) {
        if (isCancellation(err)) {
          setStatus('idle');
          setProgress(null);
          return;
        }
        setError(cleanError(err));
        setProgress(null);
        setStatus('error');
      }
    },
    [activeModelId, settings, refreshModels],
  );

  const updateSettings = useCallback(
    async (next: Partial<EngineConfig>) => {
      setSettings((prev) => ({ ...prev, ...next }));
      const engine = engineRef.current;
      if (engine) {
        engine.updateConfig(next);
        // temperature / system prompt apply at conversation creation, so reopen
        // while preserving the current transcript as context.
        if (status === 'ready') {
          await engine.openConversation(messagesToTurns(messagesRef.current));
        }
      }
    },
    [status],
  );

  // Persist the current transcript to IndexedDB under the active conversation.
  const persist = useCallback(
    async (id: string, msgs: ChatMessage[]) => {
      if (!msgs.some((m) => m.text.trim())) return;
      const now = Date.now();
      try {
        await putConversation({
          id,
          title: deriveTitle(msgs),
          createdAt: msgs[0]?.createdAt ?? now,
          updatedAt: now,
          messages: msgs.map(({ id: mid, role, text, createdAt, sources }) => ({
            id: mid,
            role,
            text,
            createdAt,
            ...(sources?.length ? { sources } : {}),
          })),
        });
        await refreshConversations();
      } catch {
        /* persistence is best-effort */
      }
    },
    [refreshConversations],
  );

  const send = useCallback(
    async (text: string) => {
      const engine = engineRef.current;
      if (!engine || status !== 'ready' || isGenerating || !text.trim()) return;

      // Assign a conversation id on the first message of a new chat.
      let convId = activeIdRef.current;
      if (!convId) {
        convId = crypto.randomUUID();
        activeIdRef.current = convId;
        setActiveConversationId(convId);
      }

      const prompt = text.trim();
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: prompt,
        createdAt: Date.now(),
      };
      const assistantId = crypto.randomUUID();
      setMessages((m) => [
        ...m,
        userMsg,
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          createdAt: Date.now(),
          streaming: true,
          searching: webSearchEnabled,
        },
      ]);
      setIsGenerating(true);

      // When web search is on, fetch sources first and ground the reply in them.
      // The user message stays the clean question; only the engine sees the
      // augmented prompt, and the sources are attached to the assistant message.
      let enginePrompt = prompt;
      if (webSearchEnabled) {
        try {
          searchAbortRef.current = new AbortController();
          const results = (
            await webSearch(prompt, searchAbortRef.current.signal)
          ).slice(0, CHAT_SEARCH_MAX_SOURCES);
          if (results.length) {
            enginePrompt = formatSearchForChat(results, prompt);
          }
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantId
                ? { ...msg, searching: false, sources: results }
                : msg,
            ),
          );
        } catch (err) {
          // Search failure shouldn't block the answer — fall back to local-only.
          const aborted = (err as Error).name === 'AbortError';
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantId
                ? {
                    ...msg,
                    searching: false,
                    text: aborted
                      ? msg.text
                      : `_[web search unavailable: ${(err as Error).message} — answering from local knowledge]_\n\n`,
                  }
                : msg,
            ),
          );
        } finally {
          searchAbortRef.current = null;
        }
      }

      try {
        for await (const token of engine.send(enginePrompt)) {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantId
                ? { ...msg, text: msg.text + token }
                : msg,
            ),
          );
        }
      } catch (err) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  text:
                    msg.text + `\n\n_[generation error: ${(err as Error).message}]_`,
                }
              : msg,
          ),
        );
      } finally {
        setIsGenerating(false);
        // Mark streaming done and persist the final transcript.
        setMessages((m) => {
          const final = m.map((msg) =>
            msg.id === assistantId ? { ...msg, streaming: false } : msg,
          );
          void persist(convId!, final);
          return final;
        });
      }
    },
    [status, isGenerating, persist, webSearchEnabled],
  );

  const generate = useCallback(
    (prompt: string, systemPrompt?: string): AsyncGenerator<string> => {
      const engine = engineRef.current;
      if (!engine || status !== 'ready') {
        throw new Error('Model is not loaded.');
      }
      return engine.generate(prompt, systemPrompt);
    },
    [status],
  );

  const cancel = useCallback(() => {
    // Downloads run in the main process, so cancelling one is an IPC call.
    void cancelDownload().catch(() => {});
    searchAbortRef.current?.abort();
    engineRef.current?.cancel();
    setIsGenerating(false);
  }, []);

  const newChat = useCallback(() => {
    setMessages([]);
    setActiveConversationId(null);
    activeIdRef.current = null;
    void engineRef.current?.openConversation([]); // fresh model context
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    // Transcripts saved before control-token filtering existed still contain the
    // raw `<image|>` noise, so clean them on the way out of storage too.
    const msgs: ChatMessage[] = conv.messages.map((m) => ({
      ...m,
      text: stripControlTokens(m.text),
    }));
    setMessages(msgs);
    setActiveConversationId(id);
    activeIdRef.current = id;
    // Seed the model with the prior turns so it has context on resume.
    await engineRef.current?.openConversation(messagesToTurns(msgs));
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      await dbDelete(id);
      await refreshConversations();
      if (activeIdRef.current === id) {
        setMessages([]);
        setActiveConversationId(null);
        activeIdRef.current = null;
        void engineRef.current?.openConversation([]);
      }
    },
    [refreshConversations],
  );

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const conv = await getConversation(id);
      if (!conv) return;
      await putConversation({ ...conv, title: title.trim() || conv.title });
      await refreshConversations();
    },
    [refreshConversations],
  );

  const exportHistory = useCallback(() => exportConversations(), []);

  const importHistory = useCallback(
    async (file: File) => {
      await importConversations(file);
      await refreshConversations();
    },
    [refreshConversations],
  );

  const value = useMemo<LlmState>(
    () => ({
      gpu,
      status,
      error,
      progress,
      models,
      activeModelId,
      activeModel,
      rejected,
      settings,
      chatWidth,
      theme,
      customGlow,
      messages,
      isGenerating,
      webSearchEnabled,
      conversations,
      activeConversationId,
      setChatWidth,
      setTheme,
      setCustomGlow,
      setActiveModel,
      setWebSearchEnabled,
      loadModel,
      addModels,
      removeModel,
      renameModel,
      dismissRejected,
      updateSettings,
      send,
      generate,
      cancel,
      newChat,
      loadConversation,
      deleteConversation,
      renameConversation,
      exportHistory,
      importHistory,
    }),
    [
      gpu,
      status,
      error,
      progress,
      models,
      activeModelId,
      activeModel,
      rejected,
      settings,
      chatWidth,
      theme,
      customGlow,
      messages,
      isGenerating,
      webSearchEnabled,
      conversations,
      activeConversationId,
      setChatWidth,
      setTheme,
      setCustomGlow,
      setActiveModel,
      setWebSearchEnabled,
      loadModel,
      addModels,
      removeModel,
      renameModel,
      dismissRejected,
      updateSettings,
      send,
      generate,
      cancel,
      newChat,
      loadConversation,
      deleteConversation,
      renameConversation,
      exportHistory,
      importHistory,
    ],
  );

  return <LlmContext.Provider value={value}>{children}</LlmContext.Provider>;
}

export function useLlm(): LlmState {
  const ctx = useContext(LlmContext);
  if (!ctx) throw new Error('useLlm must be used within <LlmProvider>');
  return ctx;
}
