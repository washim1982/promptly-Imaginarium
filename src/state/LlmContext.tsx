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
import type { SearchResult } from '../lib/search';
import { runAgentLoop } from '../lib/agent/loop';
import { inputTokenBudget } from '../lib/agent/context';
import { buildAgentSystemPrompt } from '../lib/agent/prompt';
import { createToolRuntime, TOOL_SPECS, type TaintState } from '../lib/agent/tools';
import {
  applyAgentEvent,
  buildTurnMessages,
  emptyAgentView,
  nextContextState,
  persistableView,
  type AgentContextState,
  type AgentView,
} from '../lib/agent/session';
import type { LlmFn } from '../lib/agent/types';
import { desktop } from '../lib/desktop';
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
  /** Agent-mode replies: tool steps and prose, in order. */
  agent?: AgentView;
}

export interface Workspace {
  path: string;
  name: string;
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
  /** Agent mode: the model can call tools in a multi-round loop. */
  agentEnabled: boolean;
  /** Folder the agent's file tools are confined to. */
  workspace: Workspace | null;
  // history
  conversations: ConversationMeta[];
  activeConversationId: string | null;
  // actions
  setChatWidth: (w: ChatWidth) => void;
  setTheme: (id: string) => void;
  setCustomGlow: (hex: string | null) => void;
  setActiveModel: (id: string) => void;
  setAgentEnabled: (on: boolean) => void;
  pickWorkspace: () => Promise<void>;
  clearWorkspace: () => Promise<void>;
  /** Answer an agent step waiting for approval. */
  resolveApproval: (stepId: string, approved: boolean) => void;
  /** Resolves true once the model is ready, false if it failed or was cancelled. */
  loadModel: (source: ModelSource) => Promise<boolean>;
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
const AGENT_KEY = 'imaginarium.agent';
// Replaced by the agent's web_search tool; cleared so a saved "on" can't linger.
localStorage.removeItem('imaginarium.webSearch');

const READ_TOOLS = new Set(TOOL_SPECS.filter((t) => t.readsPrivateData).map((t) => t.name));

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
  const [agentEnabled, setAgentEnabledState] = useState<boolean>(
    localStorage.getItem(AGENT_KEY) === '1',
  );
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );

  const engineRef = useRef<LlmEngine | null>(null);
  // Agent turn in flight: its abort handle, and approvals the user hasn't answered.
  const agentAbortRef = useRef<AbortController | null>(null);
  const approvalsRef = useRef(new Map<string, (approved: boolean) => void>());
  // Per-conversation agent state: compacted earlier turns, and whether workspace
  // files have been read into it (the taint gate for network tools).
  const agentContextRef = useRef<AgentContextState | undefined>(undefined);
  const taintRef = useRef<TaintState>({ privateDataRead: false });
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
    localStorage.setItem(AGENT_KEY, agentEnabled ? '1' : '0');
  }, [agentEnabled]);

  // The workspace lives in the main process; read it once on startup.
  useEffect(() => {
    const bridge = (desktop as unknown as { agent?: { getWorkspace(): Promise<Workspace | null> } })?.agent;
    void bridge?.getWorkspace().then(setWorkspace).catch(() => setWorkspace(null));
  }, []);

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

  const setAgentEnabled = useCallback((on: boolean) => {
    setAgentEnabledState(on);
  }, []);

  const agentBridge = () =>
    (desktop as unknown as {
      agent: { pickWorkspace(): Promise<Workspace | null>; clearWorkspace(): Promise<null> };
    }).agent;

  const pickWorkspace = useCallback(async () => {
    setWorkspace(await agentBridge().pickWorkspace());
  }, []);

  const clearWorkspace = useCallback(async () => {
    setWorkspace(await agentBridge().clearWorkspace());
  }, []);

  const resolveApproval = useCallback((stepId: string, approved: boolean) => {
    const resolve = approvalsRef.current.get(stepId);
    approvalsRef.current.delete(stepId);
    resolve?.(approved);
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
    async (source: ModelSource): Promise<boolean> => {
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
            return false;
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
        // Clear the ref as soon as the old engine is gone, so nothing can reach a
        // disposed engine through it while the new one initializes.
        const previous = engineRef.current;
        engineRef.current = null;
        await previous?.dispose();
        const engine = new LlmEngine(entry.label, settings);
        await engine.init(stream);
        engineRef.current = engine;
        setProgress(null);
        setStatus('ready');
        return true;
      } catch (err) {
        if (isCancellation(err)) {
          setStatus('idle');
          setProgress(null);
          return false;
        }
        setError(cleanError(err));
        setProgress(null);
        setStatus('error');
        return false;
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
          messages: msgs.map(({ id: mid, role, text, createdAt, sources, agent }) => ({
            id: mid,
            role,
            text,
            createdAt,
            ...(sources?.length ? { sources } : {}),
            ...(agent ? { agent: persistableView(agent) } : {}),
          })),
          ...(agentContextRef.current ? { agentContext: agentContextRef.current } : {}),
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
      const prior = messagesRef.current;
      const agentTurn = agentEnabled;
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: prompt,
        createdAt: Date.now(),
      };
      const assistantId = crypto.randomUUID();
      const update = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((ms) => ms.map((m) => (m.id === assistantId ? fn(m) : m)));

      setMessages((m) => [
        ...m,
        userMsg,
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          createdAt: Date.now(),
          streaming: true,
          ...(agentTurn ? { agent: emptyAgentView() } : {}),
        },
      ]);
      setIsGenerating(true);

      try {
        if (agentTurn) {
          const ctrl = new AbortController();
          agentAbortRef.current = ctrl;
          const systemPrompt = buildAgentSystemPrompt({
            persona: settings.systemPrompt,
            workspace,
            now: new Date(),
          });
          const { messages: turn, historyIndex } = buildTurnMessages(
            systemPrompt,
            prior.map(({ role, text: t }) => ({ role, text: t })),
            prompt,
            agentContextRef.current,
          );
          // The loop owns the context: every round becomes a fresh conversation
          // built from its managed message list (see LlmEngine.generateFrom).
          const llm: LlmFn = (msgs, signal) =>
            (async function* () {
              const eng = engineRef.current;
              if (!eng) throw new Error('Model is not loaded.');
              for await (const token of eng.generateFrom(msgs.map(({ role, content }) => ({ role, content })))) {
                if (signal.aborted) return;
                yield token;
              }
            })();

          const result = await runAgentLoop({
            messages: turn,
            llm,
            tools: createToolRuntime(taintRef.current),
            budget: inputTokenBudget(settings.maxNumTokens, settings.maxOutputTokens),
            signal: ctrl.signal,
            onEvent: (event) =>
              update((m) => ({ ...m, agent: applyAgentEvent(m.agent ?? emptyAgentView(), event) })),
            requestApproval: (step) =>
              new Promise<boolean>((resolve) => {
                if (ctrl.signal.aborted) resolve(false);
                else approvalsRef.current.set(step.id, resolve);
              }),
          });
          agentContextRef.current = nextContextState(agentContextRef.current, result.compaction, historyIndex);
          update((m) => ({
            ...m,
            text: result.text,
            agent: {
              ...(m.agent ?? emptyAgentView()),
              running: false,
              exhausted: result.exhausted,
              stopped: result.stopped,
            },
          }));
        } else {
          for await (const token of engine.send(prompt)) {
            update((m) => ({ ...m, text: m.text + token }));
          }
        }
      } catch (err) {
        update((m) => ({
          ...m,
          text: m.text + `\n\n_[generation error: ${cleanError(err)}]_`,
          // Agent replies render from their timeline, not `text` — so the error
          // must go into the timeline too, or it is swallowed silently.
          agent: m.agent
            ? {
                ...applyAgentEvent(m.agent, { type: 'notice', kind: 'error', message: `Error: ${cleanError(err)}` }),
                running: false,
              }
            : m.agent,
        }));
        console.error('[chat] turn failed:', err);
      } finally {
        agentAbortRef.current = null;
        approvalsRef.current.clear();
        setIsGenerating(false);
        // Mark streaming done and persist the final transcript.
        setMessages((m) => {
          const final = m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, streaming: false, agent: msg.agent ? { ...msg.agent, running: false } : msg.agent }
              : msg,
          );
          void persist(convId!, final);
          // Agent turns bypass the chat conversation; reseed it so plain chat
          // afterwards still sees them.
          if (agentTurn) void engineRef.current?.openConversation(messagesToTurns(final)).catch(() => {});
          return final;
        });
      }
    },
    [status, isGenerating, persist, agentEnabled, workspace, settings],
  );

  // Tool generations in flight (PDF, Research, SVN review). They share the one
  // engine with chat, so while any runs the chat composer must stay disabled.
  const toolRunsRef = useRef(0);

  /**
   * Checks the engine ref, not `status` state: a caller that awaits loadModel()
   * and then generates in the same async function holds a closure from before
   * the load, where `status` was not yet 'ready'. The ref is always current.
   */
  const generate = useCallback(
    (prompt: string, systemPrompt?: string): AsyncGenerator<string> => {
      const engine = engineRef.current;
      if (!engine) throw new Error('Model is not loaded.');
      const inner = engine.generate(prompt, systemPrompt);
      return (async function* tracked() {
        toolRunsRef.current += 1;
        setIsGenerating(true);
        try {
          yield* inner;
        } finally {
          toolRunsRef.current -= 1;
          if (toolRunsRef.current === 0) setIsGenerating(false);
        }
      })();
    },
    [],
  );

  const cancel = useCallback(() => {
    // Downloads run in the main process, so cancelling one is an IPC call.
    void cancelDownload().catch(() => {});
    agentAbortRef.current?.abort();
    // Unanswered approvals resolve as declined so the loop can unwind.
    for (const resolve of approvalsRef.current.values()) resolve(false);
    approvalsRef.current.clear();
    engineRef.current?.cancel();
    setIsGenerating(false);
  }, []);

  const resetAgentState = () => {
    agentContextRef.current = undefined;
    taintRef.current = { privateDataRead: false };
  };

  const newChat = useCallback(() => {
    setMessages([]);
    setActiveConversationId(null);
    activeIdRef.current = null;
    resetAgentState();
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
      agent: m.agent ? { ...m.agent, running: false } : undefined,
    }));
    // Restore the agent's compacted history, and re-arm the taint gate if this
    // conversation already read workspace files.
    agentContextRef.current = conv.agentContext;
    taintRef.current = {
      privateDataRead: msgs.some((m) =>
        Object.values(m.agent?.steps ?? {}).some((s) => READ_TOOLS.has(s.tool) && s.status === 'done'),
      ),
    };
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
        resetAgentState();
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
      agentEnabled,
      workspace,
      conversations,
      activeConversationId,
      setChatWidth,
      setTheme,
      setCustomGlow,
      setActiveModel,
      setAgentEnabled,
      pickWorkspace,
      clearWorkspace,
      resolveApproval,
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
      agentEnabled,
      workspace,
      conversations,
      activeConversationId,
      setChatWidth,
      setTheme,
      setCustomGlow,
      setActiveModel,
      setAgentEnabled,
      pickWorkspace,
      clearWorkspace,
      resolveApproval,
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
