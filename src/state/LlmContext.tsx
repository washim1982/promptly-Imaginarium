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
  browseForModel,
  cancelDownload,
  downloadModel,
  linkedModel as getLinkedModel,
  openModelStream,
  unlinkModel,
  type LinkedModel,
  type LoadProgress,
} from '../lib/modelStore';
import {
  DEFAULT_MODEL_ID,
  MODELS,
  type ModelId,
  type ModelSpec,
} from '../lib/models';
import type { ChatWidth } from '../lib/ui';
import { DEFAULT_THEME_ID, resolveAccent } from '../lib/themes';
import { webSearch, formatSearchForChat, type SearchResult } from '../lib/search';
import { cleanError, isCancellation } from '../lib/desktop';

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
  /** Use the file already registered for this model. */
  | { type: 'linked' }
  /** Open the native file picker, then use whatever the user chooses. */
  | { type: 'browse' }
  /** Download from Hugging Face into the app's own model directory. */
  | { type: 'download' };

interface LlmState {
  gpu: GpuSupport | null;
  status: EngineStatus;
  error: string | null;
  progress: LoadProgress | null;
  activeModelId: ModelId;
  /** The .litertlm file backing the active model, if one is registered. */
  linked: LinkedModel | null;
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
  setActiveModel: (id: ModelId) => void;
  setWebSearchEnabled: (on: boolean) => void;
  loadModel: (source: ModelSource) => Promise<void>;
  /** The registered file for a model, re-checked against disk. */
  modelFile: (id: ModelId) => Promise<LinkedModel | null>;
  /** Forget a model file. Downloaded copies are deleted; user files are not. */
  forgetModel: (id: ModelId) => Promise<void>;
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

const DEFAULT_SETTINGS: EngineConfig = {
  temperature: 0.75,
  maxNumTokens: 8192,
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
  const [linked, setLinked] = useState<LinkedModel | null>(null);
  const [activeModelId, setActiveModelId] = useState<ModelId>(
    (localStorage.getItem(MODEL_KEY) as ModelId) || DEFAULT_MODEL_ID,
  );
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
    localStorage.setItem(MODEL_KEY, activeModelId);
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

  const modelFile = useCallback(
    (id: ModelId) => getLinkedModel(MODELS[id]),
    [],
  );

  const forgetModel = useCallback(
    async (id: ModelId) => {
      await unlinkModel(MODELS[id]);
      if (id === activeModelId) {
        setLinked(null);
        if (status === 'ready') {
          await engineRef.current?.dispose();
          engineRef.current = null;
          setStatus('idle');
        }
      }
    },
    [activeModelId, status],
  );

  // Track which file backs the active model so the loader and settings panel can
  // show its real path instead of a vague "cached" flag.
  useEffect(() => {
    let active = true;
    getLinkedModel(MODELS[activeModelId])
      .then((entry) => {
        if (active) setLinked(entry);
      })
      .catch(() => {
        if (active) setLinked(null);
      });
    return () => {
      active = false;
    };
  }, [activeModelId, status]);

  const setActiveModel = useCallback((id: ModelId) => {
    setActiveModelId(id);
  }, []);

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
      const spec: ModelSpec = MODELS[activeModelId];
      setError(null);
      try {
        // 1. Make sure a real file on disk is registered for this model.
        let entry: LinkedModel | null;
        if (source.type === 'browse') {
          entry = await browseForModel(spec);
          if (!entry) return; // user cancelled the picker — stay where we were
          setLinked(entry);
        } else if (source.type === 'download') {
          setStatus('downloading');
          setProgress({ receivedBytes: 0, totalBytes: null, ratio: 0 });
          entry = await downloadModel(spec, setProgress);
          setLinked(entry);
        } else {
          entry = await getLinkedModel(spec);
          if (!entry) {
            throw new Error(
              'No model file is linked yet. Choose a .litertlm file to get started.',
            );
          }
          setLinked(entry);
        }

        // 2. Stream it into the WebGPU engine. Nothing is copied: the bytes go
        //    from disk through the app:// handler straight into the wasm heap.
        setStatus('reading');
        setProgress({ receivedBytes: 0, totalBytes: entry.size, ratio: 0 });
        const stream = await openModelStream(spec, setProgress);

        setStatus('initializing');
        await engineRef.current?.dispose();
        const engine = new LlmEngine(spec.label, settings);
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
    [activeModelId, settings],
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
    const msgs: ChatMessage[] = conv.messages.map((m) => ({ ...m }));
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
      activeModelId,
      linked,
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
      modelFile,
      forgetModel,
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
      activeModelId,
      linked,
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
      modelFile,
      forgetModel,
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
