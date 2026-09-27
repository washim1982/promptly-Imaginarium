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
import { formatSearchForChat, webSearch, type SearchResult } from '../lib/search';
import { decideAutoSearch, searchQueryFor } from '../lib/autoSearch';
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
import {
  attachmentCharBudget,
  buildPromptWithAttachments,
  type AttachmentMeta,
  type ChatAttachment,
} from '../lib/attachments';

export type EngineStatus =
  | 'checking-gpu'
  | 'unsupported'
  | 'idle'
  | 'downloading'
  | 'reading'
  | 'initializing'
  | 'ready'
  | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  streaming?: boolean;
  searching?: boolean;
  sources?: SearchResult[];
  agent?: AgentView;
  attachments?: AttachmentMeta[];
  modelText?: string;
}

export interface Workspace {
  path: string;
  name: string;
}

export type ModelSource =
  | { type: 'library'; id?: string }
  | { type: 'add' }
  | { type: 'download'; suggestion: ModelSuggestion };

interface LlmState {
  gpu: GpuSupport | null;
  status: EngineStatus;
  error: string | null;
  progress: LoadProgress | null;
  models: ModelEntry[];
  activeModelId: string | null;
  activeModel: ModelEntry | null;
  rejected: AddResult['rejected'];
  settings: EngineConfig;
  chatWidth: ChatWidth;
  theme: string;
  customGlow: string | null;
  messages: ChatMessage[];
  isGenerating: boolean;
  agentEnabled: boolean;
  autoWebSearch: boolean;
  workspace: Workspace | null;
  attachments: ChatAttachment[];
  addAttachment: (a: Omit<ChatAttachment, 'id'>) => void;
  removeAttachment: (id: string) => void;
  conversations: ConversationMeta[];
  activeConversationId: string | null;
  setChatWidth: (w: ChatWidth) => void;
  setTheme: (id: string) => void;
  setCustomGlow: (hex: string | null) => void;
  setActiveModel: (id: string) => void;
  setAgentEnabled: (on: boolean) => void;
  setAutoWebSearch: (on: boolean) => void;
  pickWorkspace: () => Promise<void>;
  clearWorkspace: () => Promise<void>;
  resolveApproval: (stepId: string, approved: boolean) => void;
  loadModel: (source: ModelSource) => Promise<boolean>;
  addModels: () => Promise<AddResult>;
  removeModel: (id: string) => Promise<void>;
  renameModel: (id: string, label: string) => Promise<void>;
  dismissRejected: () => void;
  updateSettings: (next: Partial<EngineConfig>) => Promise<void>;
  send: (text: string) => Promise<void>;
  generate: (prompt: string, systemPrompt?: string) => AsyncGenerator<string>;
  cancel: () => void;
  newChat: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  exportHistory: () => Promise<void>;
  importHistory: (file: File) => Promise<void>;
}

const DEFAULT_SETTINGS: EngineConfig = {
  temperature: 0.75,
  topK: 64,
  topP: 0.95,
  maxNumTokens: 8192,
  maxOutputTokens: 2048,
  systemPrompt: 'You are OMNI-STUDIO, a helpful, concise assistant.',
};

const SETTINGS_KEY = 'imaginarium.settings';
const MODEL_KEY = 'imaginarium.activeModel';
const CHAT_WIDTH_KEY = 'imaginarium.chatWidth';
const THEME_KEY = 'imaginarium.theme';
const GLOW_KEY = 'imaginarium.customGlow';
const AGENT_KEY = 'imaginarium.agent';
const AUTO_SEARCH_KEY = 'imaginarium.autoWebSearch';
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

function messagesToTurns(msgs: ChatMessage[]): HistoryTurn[] {
  return msgs
    .filter((m) => m.text.trim())
    .map((m) => ({ role: m.role, content: m.modelText ?? m.text }));
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
  const [autoWebSearch, setAutoWebSearchState] = useState<boolean>(
    localStorage.getItem(AUTO_SEARCH_KEY) !== '0',
  );
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );

  const engineRef = useRef<LlmEngine | null>(null);
  const agentAbortRef = useRef<AbortController | null>(null);
  const approvalsRef = useRef(new Map<string, (approved: boolean) => void>());
  const agentContextRef = useRef<AgentContextState | undefined>(undefined);
  const taintRef = useRef<TaintState>({ privateDataRead: false });
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeIdRef = useRef<string | null>(null);

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
    }
  }, []);

  useEffect(() => {
    refreshConversations();
  }, [refreshConversations]);

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
  useEffect(() => {
    localStorage.setItem(AUTO_SEARCH_KEY, autoWebSearch ? '1' : '0');
  }, [autoWebSearch]);

  useEffect(() => {
    const bridge = (desktop as unknown as { agent?: { getWorkspace(): Promise<Workspace | null> } })?.agent;
    void bridge?.getWorkspace().then(setWorkspace).catch(() => setWorkspace(null));
  }, []);

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

  useEffect(() => {
    const onUnload = () => engineRef.current?.dispose();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      engineRef.current?.dispose();
    };
  }, []);

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
      setActiveModelId(result.added[0].id);
    }
    return result;
  }, [refreshModels]);

  const removeModel = useCallback(
    async (id: string) => {
      await dropModel(id);
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

  const setAutoWebSearch = useCallback((on: boolean) => {
    setAutoWebSearchState(on);
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

  const addAttachment = useCallback((a: Omit<ChatAttachment, 'id'>) => {
    setAttachments((list) =>
      list.some((x) => x.kind === a.kind && x.title === a.title && x.text === a.text)
        ? list
        : [...list, { ...a, id: crypto.randomUUID() }],
    );
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((list) => list.filter((a) => a.id !== id));
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
    setCustomGlowState(null);
  }, []);

  const setCustomGlow = useCallback((hex: string | null) => {
    setCustomGlowState(hex);
  }, []);

  const loadModel = useCallback(
    async (source: ModelSource): Promise<boolean> => {
      setError(null);
      try {
        let entry: ModelEntry | undefined;
        if (source.type === 'add') {
          const result = await pickModels();
          setRejected(result.rejected);
          if (!result.added.length) {
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

        setStatus('reading');
        setProgress({ receivedBytes: 0, totalBytes: entry.size, ratio: 0 });
        const stream = await openModelStream(entry.id, setProgress);

        setStatus('initializing');
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
        if (status === 'ready') {
          await engine.openConversation(messagesToTurns(messagesRef.current));
        }
      }
    },
    [status],
  );

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
          messages: msgs.map(({ id: mid, role, text, createdAt, sources, agent, attachments: att, modelText }) => ({
            id: mid,
            role,
            text,
            createdAt,
            ...(sources?.length ? { sources } : {}),
            ...(agent ? { agent: persistableView(agent) } : {}),
            ...(att?.length ? { attachments: att } : {}),
            ...(modelText ? { modelText } : {}),
          })),
          ...(agentContextRef.current ? { agentContext: agentContextRef.current } : {}),
        });
        await refreshConversations();
      } catch {
      }
    },
    [refreshConversations],
  );

  const send = useCallback(
    async (text: string) => {
      const engine = engineRef.current;
      const pending = attachments;
      if (!engine || status !== 'ready' || isGenerating || (!text.trim() && !pending.length)) return;

      let convId = activeIdRef.current;
      if (!convId) {
        convId = crypto.randomUUID();
        activeIdRef.current = convId;
        setActiveConversationId(convId);
      }

      const prompt = text.trim() || (pending.length === 1 ? 'Summarize the attached item.' : 'Summarize the attached items.');
      const prior = messagesRef.current;
      const agentTurn = agentEnabled;
      const budget = inputTokenBudget(settings.maxNumTokens, settings.maxOutputTokens);
      const { modelText, meta } = buildPromptWithAttachments(prompt, pending, attachmentCharBudget(budget));
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: prompt,
        createdAt: Date.now(),
        ...(meta.length ? { attachments: meta, modelText } : {}),
      };
      setAttachments([]);
      if (pending.length) taintRef.current.privateDataRead = true;
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
            prior.map(({ role, text: t, modelText: mt }) => ({ role, text: mt ?? t })),
            modelText,
            agentContextRef.current,
          );
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
            budget,
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
          let toSend = modelText;
          const decision = autoWebSearch
            ? decideAutoSearch(prompt, { hasAttachments: pending.length > 0 })
            : { search: false as const, reason: 'not-needed' as const };
          if (decision.search) {
            update((m) => ({ ...m, searching: true }));
            try {
              const results = await webSearch(searchQueryFor(prompt));
              if (results.length) {
                toSend = formatSearchForChat(results, prompt);
                update((m) => ({ ...m, sources: results }));
              } else {
                update((m) => ({
                  ...m,
                  text: '_[No web results came back — answering from the model’s own knowledge, which may be out of date.]_\n\n',
                }));
              }
            } catch (err) {
              update((m) => ({ ...m, text: `_[Web search unavailable: ${cleanError(err)}]_\n\n` }));
            } finally {
              update((m) => ({ ...m, searching: false }));
            }
          }
          for await (const token of engine.send(toSend)) {
            update((m) => ({ ...m, text: m.text + token }));
          }
        }
      } catch (err) {
        update((m) => ({
          ...m,
          text: m.text + `\n\n_[generation error: ${cleanError(err)}]_`,
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
        setMessages((m) => {
          const final = m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, streaming: false, agent: msg.agent ? { ...msg.agent, running: false } : msg.agent }
              : msg,
          );
          void persist(convId!, final);
          if (agentTurn) void engineRef.current?.openConversation(messagesToTurns(final)).catch(() => {});
          return final;
        });
      }
    },
    [status, isGenerating, persist, agentEnabled, autoWebSearch, workspace, settings, attachments],
  );

  const toolRunsRef = useRef(0);

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
    void cancelDownload().catch(() => {});
    agentAbortRef.current?.abort();
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
    void engineRef.current?.openConversation([]);
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    const msgs: ChatMessage[] = conv.messages.map((m) => ({
      ...m,
      text: stripControlTokens(m.text),
      agent: m.agent ? { ...m.agent, running: false } : undefined,
    }));
    agentContextRef.current = conv.agentContext;
    taintRef.current = {
      privateDataRead: msgs.some(
        (m) =>
          Boolean(m.attachments?.length) ||
          Object.values(m.agent?.steps ?? {}).some((s) => READ_TOOLS.has(s.tool) && s.status === 'done'),
      ),
    };
    setMessages(msgs);
    setActiveConversationId(id);
    activeIdRef.current = id;
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
      autoWebSearch,
      workspace,
      attachments,
      addAttachment,
      removeAttachment,
      conversations,
      activeConversationId,
      setChatWidth,
      setTheme,
      setCustomGlow,
      setActiveModel,
      setAgentEnabled,
      setAutoWebSearch,
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
      autoWebSearch,
      workspace,
      attachments,
      addAttachment,
      removeAttachment,
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
