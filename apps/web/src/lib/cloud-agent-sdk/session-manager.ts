import type { Images } from '@/lib/images-schema';
import { errorShapeSchema } from './schemas';
import { atom } from 'jotai';
import type { Atom, WritableAtom } from 'jotai';
import { createCloudAgentSession } from './session';
import type { CloudAgentSession } from './session';
import { createJotaiStorage } from './storage/jotai';
import type { JotaiSessionStorage, JotaiStore } from './storage/jotai';
import type { CloudAgentApi, CloudAgentStreamTicketResult } from './transport';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import type {
  CloudAgentSessionId,
  KiloSessionId,
  ResolvedSession,
  SessionSnapshot,
  SessionInfo,
  SessionActivity,
  AgentStatus,
  CloudStatus,
  QuestionState,
  PermissionState,
  SuggestionAction,
  SuggestionState,
  MessageInfo,
  Part,
  TextPart,
} from './types';
import type { QuestionInfo } from '@/types/opencode.gen';
import { splitByContiguousPrefix } from './array-utils';
import { generateMessageId } from './message-id';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StoredMessage = { info: MessageInfo; parts: Part[] };
type SessionStatusIndicator = {
  type: 'error' | 'warning' | 'info' | 'progress';
  message: string;
  timestamp: number;
};
type SessionConfig = {
  sessionId: CloudAgentSessionId | KiloSessionId;
  repository: string;
  mode: string;
  model: string;
  variant?: string | null;
};
type ActiveSessionType = 'cloud-agent' | 'remote';
type StandaloneQuestion = { requestId: string; questions: QuestionInfo[] };
type StandalonePermission = {
  requestId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
};
type StandaloneSuggestion = {
  requestId: string;
  text: string;
  actions: SuggestionAction[];
  /** Tool call ID that emitted this suggestion, when available. */
  callId?: string;
};

type FetchedSessionData = {
  kiloSessionId: KiloSessionId;
  cloudAgentSessionId: CloudAgentSessionId | null;
  title: string | null;
  organizationId: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  mode: string | null;
  model: string | null;
  variant: string | null;
  repository: string | null;
  isInitiated: boolean;
  needsLegacyPrepare: boolean;
  isPreparingAsync: boolean;
  prompt: string | null;
  initialMessageId: string | null;
};

type PrepareInput = {
  prompt: string;
  mode: string;
  model: string;
  variant?: string;
  githubRepo?: string;
  gitlabProject?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  upstreamBranch?: string;
  autoCommit?: boolean;
  profileName?: string;
};

type SessionManagerConfig = {
  store: JotaiStore;
  resolveSession: (kiloSessionId: KiloSessionId) => Promise<ResolvedSession>;
  getTicket: (
    sessionId: CloudAgentSessionId
  ) => CloudAgentStreamTicketResult | Promise<CloudAgentStreamTicketResult>;
  fetchSnapshot: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  getAuthToken: () => string | Promise<string>;
  cliWebsocketUrl?: string;
  websocketBaseUrl?: string;
  api: CloudAgentApi;
  lifecycleHooks?: ConnectionLifecycleHooks;
  websocketHeaders?: WebSocketHeaders;
  prepare: (
    input: PrepareInput
  ) => Promise<{ cloudAgentSessionId: CloudAgentSessionId; kiloSessionId: KiloSessionId }>;
  initiate: (input: { cloudAgentSessionId: CloudAgentSessionId }) => Promise<unknown>;
  fetchSession: (kiloSessionId: KiloSessionId) => Promise<FetchedSessionData>;
  onKiloSessionCreated?: (kiloSessionId: KiloSessionId) => void;
  onComplete?: () => void;
  onBranchChanged?: (branch: string) => void;
  onSendFailed?: (messageText: string, displayMessage?: string, error?: unknown) => void;
  onRemoteSessionOpened?: (data: { kiloSessionId: KiloSessionId }) => void;
  onRemoteSessionMessageSent?: (data: { kiloSessionId: KiloSessionId }) => void;
};

// Writable/read-only atom aliases for the public atoms record
type W<T> = WritableAtom<T, [T], void>;

type SessionManagerAtoms = {
  isStreaming: W<boolean>;
  isLoading: W<boolean>;
  /** Session structurally cannot accept input (no transport send). */
  isReadOnly: W<boolean>;
  canSend: W<boolean>;
  canInterrupt: W<boolean>;
  statusIndicator: W<SessionStatusIndicator | null>;
  error: W<string | null>;
  question: W<QuestionState | null>;
  activeQuestion: W<StandaloneQuestion | null>;
  activePermission: W<StandalonePermission | null>;
  activeSuggestion: W<StandaloneSuggestion | null>;
  sessionInfo: W<SessionInfo | null>;
  sessionId: W<CloudAgentSessionId | null>;
  activity: W<SessionActivity>;
  agentStatus: W<AgentStatus>;
  cloudStatus: W<CloudStatus | null>;
  sessionConfig: W<SessionConfig | null>;
  chatUI: W<{ shouldAutoScroll: boolean }>;
  permission: W<PermissionState | null>;
  suggestion: W<SuggestionState | null>;
  failedPrompt: W<string | null>;
  fetchedSessionData: W<FetchedSessionData | null>;
  messagesList: Atom<StoredMessage[]>;
  staticMessages: Atom<StoredMessage[]>;
  dynamicMessages: Atom<StoredMessage[]>;
  totalCost: Atom<number>;
  childMessages: Atom<(childSessionId: string) => StoredMessage[]>;
};

type SessionManager = {
  switchSession(kiloSessionId: KiloSessionId): Promise<void>;
  send(payload: {
    prompt: string;
    mode: string;
    model: string;
    variant?: string;
    images?: Images;
  }): Promise<boolean>;
  interrupt(): Promise<void>;
  answerQuestion(requestId: string, answers: string[][]): Promise<void>;
  rejectQuestion(requestId: string): Promise<void>;
  respondToPermission(requestId: string, response: 'once' | 'always' | 'reject'): Promise<void>;
  acceptSuggestion(requestId: string, index: number): Promise<void>;
  dismissSuggestion(requestId: string): Promise<void>;
  createAndStart(input: PrepareInput): Promise<void>;
  clearError(): void;
  destroy(): void;
  atoms: SessionManagerAtoms;
};

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed'))
      return 'Connection lost. Please retry in a moment.';
    return 'Connection failed. Please retry in a moment.';
  }
  const r = errorShapeSchema.safeParse(err);
  if (r.success) {
    const code = r.data.data?.code ?? r.data.shape?.code;
    const http = r.data.data?.httpStatus ?? r.data.shape?.data?.httpStatus;
    if (code === 'PAYMENT_REQUIRED' || http === 402)
      return 'Insufficient credits. Please add at least $1 to continue using Cloud Agent.';
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN')
      return 'You are not authorized to use the Cloud Agent.';
    if (code === 'NOT_FOUND') return 'Service is unavailable right now. Please try again.';
    if (code === 'CONFLICT' || http === 409)
      return 'Previous task is still finishing up. Please wait a moment.';
    return 'Something went wrong. Please retry in a moment.';
  }
  return 'Something went wrong. Please retry in a moment.';
}

// ---------------------------------------------------------------------------
// Streaming detection
// ---------------------------------------------------------------------------

function isMessageStreaming(msg: StoredMessage): boolean {
  if (msg.info.role === 'assistant' && !msg.info.time.completed && !msg.info.error) return true;
  return msg.parts.some(part => {
    if (part.type === 'text') return part.time !== undefined && part.time.end === undefined;
    if (part.type === 'reasoning') return part.time.end === undefined;
    if (part.type === 'tool')
      return part.state.status === 'pending' || part.state.status === 'running';
    return false;
  });
}

// ---------------------------------------------------------------------------
// Status → indicator mapping
// ---------------------------------------------------------------------------

function indicatorForCloudStatus(cs: CloudStatus): SessionStatusIndicator | null {
  const now = Date.now();
  if (cs.type === 'preparing') {
    return { type: 'progress', message: cs.message ?? 'Setting up environment…', timestamp: now };
  }
  if (cs.type === 'finalizing') {
    return { type: 'progress', message: cs.message ?? 'Wrapping up…', timestamp: now };
  }
  if (cs.type === 'error') {
    return { type: 'error', message: cs.message, timestamp: now };
  }
  return null; // 'ready' — no indicator
}

function indicatorForStatus(s: AgentStatus): SessionStatusIndicator | null {
  const now = Date.now();
  if (s.type === 'autocommit') {
    const kind = s.step === 'failed' ? 'error' : s.step === 'completed' ? 'info' : 'progress';
    return { type: kind, message: s.message, timestamp: now } satisfies SessionStatusIndicator;
  }
  if (s.type === 'disconnected')
    return { type: 'error', message: 'Agent connection lost', timestamp: now };
  if (s.type === 'error') return { type: 'error', message: s.message, timestamp: now };
  if (s.type === 'interrupted') return { type: 'info', message: 'Session stopped', timestamp: now };
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createSessionManager(config: SessionManagerConfig): SessionManager {
  const { store } = config;

  // Internal atoms
  const sessionStorageAtom = atom<JotaiSessionStorage | null>(null);
  const rootSessionIdAtom = atom<string | null>(null);

  // Public writable atoms
  const isStreamingAtom = atom(false);
  const isLoadingAtom = atom(false);
  const isReadOnlyAtom = atom(false);
  const canSendAtom = atom(false);
  const canInterruptAtom = atom(false);
  const statusIndicatorAtom = atom<SessionStatusIndicator | null>(null);
  const errorAtom = atom<string | null>(null);
  const questionAtom = atom<QuestionState | null>(null);
  const sessionInfoAtom = atom<SessionInfo | null>(null);
  const sessionIdAtom = atom<CloudAgentSessionId | null>(null);
  const activityAtom = atom<SessionActivity>({ type: 'connecting' });
  const agentStatusAtom = atom<AgentStatus>({ type: 'idle' });
  const cloudStatusAtom = atom<CloudStatus | null>(null);
  const sessionConfigAtom = atom<SessionConfig | null>(null);
  const chatUIAtom = atom<{ shouldAutoScroll: boolean }>({ shouldAutoScroll: true });
  const activeQuestionAtom = atom<StandaloneQuestion | null>(null);
  const permissionAtom = atom<PermissionState | null>(null);
  const activePermissionAtom = atom<StandalonePermission | null>(null);
  const suggestionAtom = atom<SuggestionState | null>(null);
  const activeSuggestionAtom = atom<StandaloneSuggestion | null>(null);
  const failedPromptAtom = atom<string | null>(null);
  const fetchedSessionDataAtom = atom<FetchedSessionData | null>(null);

  // Derived atoms
  const messagesListAtom = atom<StoredMessage[]>(get => {
    const storage = get(sessionStorageAtom);
    if (!storage) return [];
    const ids = get(storage.atoms.messageIds);
    const msgMap = get(storage.atoms.messages);
    const partsMap = get(storage.atoms.parts);
    const rootSessionId = get(rootSessionIdAtom);
    const out: StoredMessage[] = [];
    for (const id of ids) {
      const info = msgMap.get(id);
      if (!info) continue;
      if (rootSessionId !== null && info.sessionID !== rootSessionId) continue;
      out.push({ info, parts: partsMap.get(id) ?? [] });
    }
    return out;
  });

  const notStreaming = (msg: StoredMessage) => !isMessageStreaming(msg);
  const staticMessagesAtom = atom(
    get => splitByContiguousPrefix(get(messagesListAtom), notStreaming).staticItems
  );
  const dynamicMessagesAtom = atom(
    get => splitByContiguousPrefix(get(messagesListAtom), notStreaming).dynamicItems
  );
  const totalCostAtom = atom(get => {
    let t = 0;
    for (const m of get(messagesListAtom)) if (m.info.role === 'assistant') t += m.info.cost;
    return t;
  });
  const childMessagesAtom = atom(get => {
    const storage = get(sessionStorageAtom);
    if (!storage) return (): StoredMessage[] => [];
    const ids = get(storage.atoms.messageIds);
    const msgMap = get(storage.atoms.messages);
    const partsMap = get(storage.atoms.parts);
    return (childSessionId: string): StoredMessage[] => {
      const out: StoredMessage[] = [];
      for (const id of ids) {
        const info = msgMap.get(id);
        if (info?.sessionID === childSessionId) out.push({ info, parts: partsMap.get(id) ?? [] });
      }
      return out;
    };
  });

  // Private mutable state
  let activeSessionId: KiloSessionId | null = null;
  let currentSession: CloudAgentSession | null = null;
  let activeSessionType: ActiveSessionType | null = null;
  let stateUnsub: (() => void) | null = null;
  let indicatorTimer: ReturnType<typeof setTimeout> | null = null;

  function setIndicator(ind: SessionStatusIndicator | null): void {
    if (indicatorTimer !== null) {
      clearTimeout(indicatorTimer);
      indicatorTimer = null;
    }
    store.set(statusIndicatorAtom, ind);
    if (ind?.type === 'info')
      indicatorTimer = setTimeout(() => {
        indicatorTimer = null;
        store.set(statusIndicatorAtom, null);
      }, 3000);
  }

  function clearAllAtoms(): void {
    store.set(sessionStorageAtom, null);
    store.set(rootSessionIdAtom, null);
    store.set(isStreamingAtom, false);
    store.set(isLoadingAtom, false);
    store.set(isReadOnlyAtom, false);
    store.set(canSendAtom, false);
    store.set(canInterruptAtom, false);
    store.set(statusIndicatorAtom, null);
    store.set(errorAtom, null);
    store.set(questionAtom, null);
    store.set(sessionInfoAtom, null);
    store.set(sessionIdAtom, null);
    store.set(activityAtom, { type: 'connecting' });
    store.set(agentStatusAtom, { type: 'idle' });
    store.set(cloudStatusAtom, null);
    store.set(sessionConfigAtom, null);
    store.set(activeQuestionAtom, null);
    store.set(permissionAtom, null);
    store.set(activePermissionAtom, null);
    store.set(suggestionAtom, null);
    store.set(activeSuggestionAtom, null);
    store.set(failedPromptAtom, null);
    store.set(fetchedSessionDataAtom, null);
    store.set(chatUIAtom, { shouldAutoScroll: true });
  }

  function upsertInitialMessageFromFetchedMetadata(
    storage: JotaiSessionStorage,
    kiloSessionId: KiloSessionId,
    data: FetchedSessionData
  ): void {
    if (!data.prompt || !data.initialMessageId) return;

    storage.upsertMessage({
      id: data.initialMessageId,
      sessionID: kiloSessionId,
      role: 'user',
      time: { created: Date.now() },
      agent: '',
      model: { providerID: '', modelID: '' },
    } satisfies MessageInfo);
    storage.upsertPart(data.initialMessageId, {
      id: `${data.initialMessageId}-text`,
      sessionID: kiloSessionId,
      messageID: data.initialMessageId,
      type: 'text',
      text: data.prompt,
      synthetic: true,
    } satisfies TextPart);
  }

  function subscribeToServiceState(
    session: CloudAgentSession,
    opts?: { onFirstActivity?: () => void }
  ): void {
    let firstActivityFired = false;
    let prevAct = '';
    let prevSk = '';
    let prevCsk = '';
    let prevCloudStatusHadIndicator = false;
    const sKey = (s: AgentStatus) => (s.type === 'autocommit' ? `${s.type}:${s.step}` : s.type);
    const csKey = (cs: CloudStatus | null) =>
      cs === null
        ? ''
        : cs.type === 'preparing' || cs.type === 'finalizing'
          ? `${cs.type}:${cs.step ?? ''}:${cs.message ?? ''}`
          : cs.type;

    stateUnsub = session.state.subscribe(() => {
      const act = session.state.getActivity();
      const st = session.state.getStatus();
      const cs = session.state.getCloudStatus();
      store.set(activityAtom, act);
      if (!firstActivityFired && act.type !== 'connecting') {
        firstActivityFired = true;
        opts?.onFirstActivity?.();
      }
      store.set(agentStatusAtom, st);
      store.set(cloudStatusAtom, cs);
      store.set(isStreamingAtom, act.type === 'busy');
      store.set(questionAtom, session.state.getQuestion());
      store.set(permissionAtom, session.state.getPermission());
      store.set(suggestionAtom, session.state.getSuggestion());
      store.set(sessionInfoAtom, session.state.getSessionInfo());

      // canSend factors in cloud status: preparing/finalizing blocks input
      const cloudReady = cs === null || cs.type === 'ready';
      // Only update read-only state after the transport has been resolved.
      // During the 'connecting' phase the transport is null so canSend is
      // always false, which would briefly flash a "read-only" banner.
      if (act.type !== 'connecting') {
        store.set(isReadOnlyAtom, !session.canSend);
      }
      store.set(canSendAtom, session.canSend && cloudReady);
      store.set(canInterruptAtom, session.canInterrupt);

      if (act.type !== prevAct) {
        if (act.type === 'busy') {
          setIndicator(null);
        } else if (act.type === 'retrying') {
          setIndicator({
            type: 'warning',
            message: `Retrying… ${act.message}`,
            timestamp: Date.now(),
          });
        } else if (act.type === 'idle') {
          config.onComplete?.();
        }
        prevAct = act.type;
      }

      // Cloud status takes priority over agent status when active
      const csk = csKey(cs);
      if (cs && cs.type !== 'ready') {
        if (csk !== prevCsk) {
          const cloudInd = indicatorForCloudStatus(cs);
          if (cloudInd) {
            setIndicator(cloudInd);
            prevCloudStatusHadIndicator = true;
          }
          prevCsk = csk;
        }
      } else {
        const shouldClearCloudIndicator = prevCloudStatusHadIndicator;
        if (csk !== prevCsk) prevCsk = csk;
        prevCloudStatusHadIndicator = false;
        // Fall through to existing agent status indicator logic
        const sk = sKey(st);
        if (sk !== prevSk || shouldClearCloudIndicator) {
          const ind = indicatorForStatus(st);
          if (ind !== null || shouldClearCloudIndicator) setIndicator(ind);
          prevSk = sk;
        }
      }
    });
  }

  async function switchSession(kiloSessionId: KiloSessionId): Promise<void> {
    activeSessionId = kiloSessionId;
    activeSessionType = null;
    stateUnsub?.();
    stateUnsub = null;
    currentSession?.destroy();
    currentSession = null;
    setIndicator(null);

    // Clean slate immediately — the user asked to switch, so clear all
    // previous session state and show a loading indicator.
    clearAllAtoms();
    store.set(rootSessionIdAtom, kiloSessionId);
    store.set(isLoadingAtom, true);

    let data: FetchedSessionData;
    try {
      data = await config.fetchSession(kiloSessionId);
    } catch (err) {
      if (kiloSessionId !== activeSessionId) return;
      store.set(isLoadingAtom, false);
      setIndicator({ type: 'error', message: formatError(err), timestamp: Date.now() });
      return;
    }
    if (kiloSessionId !== activeSessionId) return;
    store.set(fetchedSessionDataAtom, data);

    const jotaiStorage = createJotaiStorage(store);
    store.set(sessionStorageAtom, jotaiStorage);

    // Populate session metadata and swap in the new storage eagerly.
    // The storage starts empty; snapshot replay (inside session.connect)
    // will populate it and the UI updates reactively.
    store.set(sessionConfigAtom, {
      sessionId: data.cloudAgentSessionId ?? kiloSessionId,
      repository: data.repository ?? '',
      mode: data.mode ?? '',
      model: data.model ?? '',
      variant: data.variant ?? null,
    });
    store.set(sessionIdAtom, data.cloudAgentSessionId);

    upsertInitialMessageFromFetchedMetadata(jotaiStorage, kiloSessionId, data);

    config.onKiloSessionCreated?.(kiloSessionId);

    const session = createCloudAgentSession({
      kiloSessionId,
      resolveSession: config.resolveSession,
      transport: {
        getTicket: config.getTicket,
        api: config.api,
        fetchSnapshot: config.fetchSnapshot,
        getAuthToken: config.getAuthToken,
        cliWebsocketUrl: config.cliWebsocketUrl,
        lifecycleHooks: config.lifecycleHooks,
        websocketHeaders: config.websocketHeaders,
      },
      websocketBaseUrl: config.websocketBaseUrl,
      storage: jotaiStorage,
      onSessionCreated: info => {
        if (info.parentID == null) {
          // Adopt the server-reported root session ID so message
          // filtering works even when switchSession was called with a
          // cast cloudAgentSessionId (the createAndStart path).
          store.set(rootSessionIdAtom, info.id);
          store.set(isLoadingAtom, false);
        }
      },
      onQuestionAsked: (requestId, questions) => {
        if (questions) {
          store.set(activeQuestionAtom, { requestId, questions });
        }
      },
      onQuestionResolved: requestId => {
        const aq = store.get(activeQuestionAtom);
        if (aq?.requestId === requestId) store.set(activeQuestionAtom, null);
      },
      onPermissionAsked: (requestId, permission, patterns, metadata, always) => {
        if (permission) {
          store.set(activePermissionAtom, {
            requestId,
            permission,
            patterns: patterns ?? [],
            metadata: metadata ?? {},
            always: always ?? [],
          });
        }
      },
      onPermissionResolved: requestId => {
        const ap = store.get(activePermissionAtom);
        if (ap?.requestId === requestId) store.set(activePermissionAtom, null);
      },
      onSuggestionAsked: (requestId, text, actions, callId) => {
        store.set(activeSuggestionAtom, { requestId, text, actions, callId });
      },
      onSuggestionResolved: requestId => {
        const as = store.get(activeSuggestionAtom);
        if (as?.requestId === requestId) store.set(activeSuggestionAtom, null);
      },
      onResolved: resolved => {
        if (resolved.type === 'cloud-agent') activeSessionType = 'cloud-agent';
        else if (resolved.type === 'remote') activeSessionType = 'remote';
      },
      onBranchChanged: branch => {
        const currentFetched = store.get(fetchedSessionDataAtom);
        if (currentFetched) {
          store.set(fetchedSessionDataAtom, { ...currentFetched, gitBranch: branch });
        }
        config.onBranchChanged?.(branch);
      },
      onError: message => store.set(errorAtom, message),
      onEvent: event => {
        if (event.type === 'message.updated' && event.info.role === 'assistant') {
          const currentConfig = store.get(sessionConfigAtom);
          if (
            currentConfig &&
            (currentConfig.model !== event.info.modelID ||
              currentConfig.mode !== event.info.mode ||
              currentConfig.variant !== (event.info.variant ?? null))
          ) {
            store.set(sessionConfigAtom, {
              ...currentConfig,
              model: event.info.modelID,
              mode: event.info.mode,
              variant: event.info.variant ?? null,
            });
          }
        }
      },
    });

    if (kiloSessionId !== activeSessionId) {
      session.destroy();
      return;
    }
    currentSession = session;
    subscribeToServiceState(session, {
      onFirstActivity: () => {
        // Fallback: clear loading when events flow even if no root
        // session.created was replayed (e.g. CLI snapshot failure).
        store.set(isLoadingAtom, false);
        if (activeSessionType === 'remote') {
          config.onRemoteSessionOpened?.({ kiloSessionId });
        }
      },
    });
    session.connect();
  }

  async function send(payload: {
    prompt: string;
    mode: string;
    model: string;
    variant?: string;
    images?: Images;
  }): Promise<boolean> {
    store.set(errorAtom, null);
    if (store.get(agentStatusAtom).type !== 'disconnected') {
      setIndicator(null);
    }

    const storage = store.get(sessionStorageAtom);
    const kiloSessionId = activeSessionId;
    const messageId = generateMessageId();
    const shouldStoreOptimisticMessage = activeSessionType === 'cloud-agent';
    const optimisticCreatedAt = Date.now();

    if (storage && kiloSessionId && shouldStoreOptimisticMessage) {
      storage.upsertMessage({
        id: messageId,
        sessionID: kiloSessionId,
        role: 'user',
        time: { created: optimisticCreatedAt },
        agent: '',
        model: { providerID: '', modelID: payload.model },
      });
      storage.upsertPart(messageId, {
        id: `${messageId}-text`,
        sessionID: kiloSessionId,
        messageID: messageId,
        type: 'text',
        text: payload.prompt,
        synthetic: true,
      });
    }

    try {
      if (!currentSession) throw new Error('No active session');
      // Snapshot before await — switchSession() can overwrite these while send is in flight.
      const sessionType = activeSessionType;
      await currentSession.send({
        prompt: payload.prompt,
        mode: payload.mode,
        model: payload.model,
        variant: payload.variant,
        messageId,
        images: payload.images,
      });
      if (sessionType === 'remote' && kiloSessionId) {
        config.onRemoteSessionMessageSent?.({ kiloSessionId });
      }
      return true;
    } catch (err) {
      if (storage && shouldStoreOptimisticMessage) {
        storage.deleteMessage(messageId);
      }
      store.set(failedPromptAtom, payload.prompt);
      const message = formatError(err);
      config.onSendFailed?.(payload.prompt, message, err);
      if (store.get(agentStatusAtom).type !== 'disconnected') {
        setIndicator({ type: 'error', message, timestamp: Date.now() });
      }
      return false;
    }
  }

  async function interrupt(): Promise<void> {
    if (!currentSession) return;
    // Snapshot before await — switchSession()/destroy() can swap currentSession while in flight.
    const session = currentSession;
    // Eagerly disable send/interrupt to prevent the user from sending a
    // message while the async interrupt HTTP call is in flight. We do NOT
    // call disconnect() — interrupt stops the agent but keeps the transport
    // alive so the user can continue the session.
    store.set(canSendAtom, false);
    store.set(canInterruptAtom, false);
    try {
      if (session.canInterrupt) {
        await session.interrupt();
      }
      if (currentSession === session) {
        setIndicator({ type: 'info', message: 'Session stopped', timestamp: Date.now() });
      }
    } catch {
      if (currentSession === session) {
        store.set(canInterruptAtom, session.canInterrupt);
        const cs = store.get(cloudStatusAtom);
        const cloudReady = cs === null || cs.type === 'ready';
        store.set(canSendAtom, session.canSend && cloudReady);
        store.set(errorAtom, 'Failed to stop execution');
      }
    }
  }

  async function answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    if (currentSession) await currentSession.answer({ requestId, answers });
  }

  async function rejectQuestion(requestId: string): Promise<void> {
    if (currentSession) await currentSession.reject({ requestId });
  }

  async function respondToPermission(
    requestId: string,
    response: 'once' | 'always' | 'reject'
  ): Promise<void> {
    if (currentSession) await currentSession.respondToPermission({ requestId, response });
  }

  async function acceptSuggestion(requestId: string, index: number): Promise<void> {
    if (currentSession) await currentSession.acceptSuggestion({ requestId, index });
  }

  async function dismissSuggestion(requestId: string): Promise<void> {
    if (currentSession) await currentSession.dismissSuggestion({ requestId });
  }

  async function createAndStart(input: PrepareInput): Promise<void> {
    try {
      const { cloudAgentSessionId, kiloSessionId } = await config.prepare(input);
      await config.initiate({ cloudAgentSessionId });
      store.set(sessionIdAtom, cloudAgentSessionId);
      await switchSession(kiloSessionId);
    } catch (err) {
      setIndicator({ type: 'error', message: formatError(err), timestamp: Date.now() });
    }
  }

  function destroy(): void {
    stateUnsub?.();
    stateUnsub = null;
    currentSession?.destroy();
    currentSession = null;
    if (indicatorTimer !== null) {
      clearTimeout(indicatorTimer);
      indicatorTimer = null;
    }
    clearAllAtoms();
    activeSessionId = null;
    activeSessionType = null;
  }

  return {
    switchSession,
    send,
    interrupt,
    answerQuestion,
    rejectQuestion,
    respondToPermission,
    acceptSuggestion,
    dismissSuggestion,
    createAndStart,
    clearError: () => {
      store.set(errorAtom, null);
      setIndicator(null);
    },
    destroy,
    atoms: {
      isStreaming: isStreamingAtom,
      isLoading: isLoadingAtom,
      isReadOnly: isReadOnlyAtom,
      canSend: canSendAtom,
      canInterrupt: canInterruptAtom,
      statusIndicator: statusIndicatorAtom,
      error: errorAtom,
      question: questionAtom,
      sessionInfo: sessionInfoAtom,
      sessionId: sessionIdAtom,
      activity: activityAtom,
      agentStatus: agentStatusAtom,
      cloudStatus: cloudStatusAtom,
      sessionConfig: sessionConfigAtom,
      chatUI: chatUIAtom,
      activeQuestion: activeQuestionAtom,
      permission: permissionAtom,
      activePermission: activePermissionAtom,
      suggestion: suggestionAtom,
      activeSuggestion: activeSuggestionAtom,
      failedPrompt: failedPromptAtom,
      fetchedSessionData: fetchedSessionDataAtom,
      messagesList: messagesListAtom,
      staticMessages: staticMessagesAtom,
      dynamicMessages: dynamicMessagesAtom,
      totalCost: totalCostAtom,
      childMessages: childMessagesAtom,
    },
  };
}

export { createSessionManager, formatError };
export type {
  SessionManager,
  SessionManagerConfig,
  SessionManagerAtoms,
  SessionStatusIndicator,
  SessionConfig,
  StandalonePermission,
  StandaloneQuestion,
  StandaloneSuggestion,
  StoredMessage,
  FetchedSessionData,
  PrepareInput,
};
