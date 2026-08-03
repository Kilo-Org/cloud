import type { CloudAgentAttachments } from '@kilocode/app-shared/cloud-agent';
import type { Images } from '@kilocode/app-shared/images-schema';
import { errorShapeSchema } from './schemas';
import type {
  CreateRemoteSessionInput,
  RemoteAttachmentPart,
  SendCommandPayload,
  SendPromptPayload,
  TransportSendPayload,
} from './transport';
import { modelRefsEqual } from './remote-model-catalog';
import type {
  ModelRef,
  ModelSelection,
  RemoteModelOverride,
  RemoteModelState,
} from './remote-model-catalog';
import type { RemoteCommandState } from './remote-command-catalog';
import { atom } from 'jotai';
import type { Atom, WritableAtom } from 'jotai';
import {
  createCloudAgentSession,
  REMOTE_SESSION_EXIT_NOT_SUPPORTED,
  REMOTE_SESSION_CREATION_NOT_SUPPORTED,
} from './session';
import type { CloudAgentSession } from './session';
import { createChatProcessor } from './chat-processor';
import { createJotaiStorage } from './storage/jotai';
import type { JotaiSessionStorage, JotaiStore } from './storage/jotai';
import type { CloudAgentApi, CloudAgentStreamTicketResult } from './transport';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import type {
  CloudAgentSessionId,
  KiloSessionId,
  ResolvedSession,
  SessionSnapshot,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
  SessionInfo,
  SessionActivity,
  AgentStatus,
  CloudStatus,
  QuestionState,
  PermissionState,
  SlashCommandInfo,
  SuggestionAction,
  SuggestionState,
  MessageDeliveryState,
  MessageInfo,
  Part,
  OlderMessagesError,
  PreparationAttempt,
} from './types';
import type { QuestionInfo } from '@kilocode/app-shared/opencode';
import { splitByContiguousPrefix } from './array-utils';
import type { UserWebConnection } from './user-web-connection';
import { generateMessageId } from './message-id';
import { findLatestContextUsage } from './context-usage';
import type { ContextUsage } from './context-usage';
import { CLI_MODEL_ID, cliModelLabel } from './cli-model';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StoredMessage = { info: MessageInfo; parts: Part[] };
type SessionManagerPromptPayload = Omit<SendPromptPayload, 'model'> & { model?: string };
type SessionManagerSendPayload = SessionManagerPromptPayload | SendCommandPayload;
/** In-session cloud-agent model pick. Separate from remoteModelOverride — no remote clear rules. */
type CloudAgentModelOverride = {
  model: string;
  variant?: string;
};
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
  providerID?: string | null;
  variant?: string | null;
  /** Custom modes exposed by this session's profile stack (slug + name, plus optional model and thinking-effort overrides). */
  runtimeAgents?: Array<{ slug: string; name: string; model?: string; variant?: string }>;
};
type ActiveSessionType = ResolvedSession['type'];
type ObservedModelSource = 'session' | 'message' | 'catalog';
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
type ChildSessionHydrationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

const IDLE_CHILD_SESSION_HYDRATION_STATE = {
  status: 'idle',
} satisfies ChildSessionHydrationState;

const EMPTY_REMOTE_MODEL_STATE = {
  ownerConnectionId: null,
  protocol: 'unknown',
  refresh: 'idle',
} satisfies RemoteModelState;

const EMPTY_REMOTE_COMMAND_STATE = {
  ownerConnectionId: null,
  refresh: 'idle',
  commands: [],
} satisfies RemoteCommandState;

/** UUID v1–v5 shape used to gate orgId inheritance on create_session. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TRANSCRIPT_CLEARED_INDICATOR = 'View cleared — earlier messages are still on this session';

/**
 * Flatten a `ModelSelection` into the Decision 5 create_session model object.
 * `variant` is nested only when present (no second top-level field).
 */
function flattenModelSelectionForCreate(selection: ModelSelection): {
  providerID: string;
  modelID: string;
  variant?: string;
} {
  return {
    providerID: selection.model.providerID,
    modelID: selection.model.modelID,
    ...(selection.variant ? { variant: selection.variant } : {}),
  };
}

/**
 * Compute optional inheritance fields for `/new` create_session from the
 * active session's manager state (Decision 6).
 */
function computeCreateRemoteSessionInheritance(args: {
  modelSelection: ModelSelection | null | undefined;
  sessionMode: string | null | undefined;
  lastPromptMode: string | null;
  organizationId: string | null | undefined;
}): CreateRemoteSessionInput {
  const input: CreateRemoteSessionInput = {};
  if (args.modelSelection) {
    input.model = flattenModelSelectionForCreate(args.modelSelection);
  }
  const mode = args.sessionMode && args.sessionMode !== '' ? args.sessionMode : args.lastPromptMode;
  if (mode) {
    input.agent = mode;
  }
  if (args.organizationId && UUID_RE.test(args.organizationId)) {
    input.orgId = args.organizationId;
  }
  return input;
}

type AssociatedPrData = {
  url: string;
  number: number;
  state: string;
  title: string | null;
  headSha: string | null;
  lastSyncedAt: string;
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
  /** Custom modes exposed by this session's profile stack (slug + name, plus optional model and thinking-effort overrides). */
  runtimeAgents?: Array<{ slug: string; name: string; model?: string; variant?: string }>;
  associatedPr: AssociatedPrData | null;
  totalCostMicrodollars?: number | null;
  /** Origin platform (`created_on_platform`). Populated by the mobile adapter only. */
  createdOnPlatform?: string | null;
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
  profileId?: string;
  /** Optional structured payload for the first execution (command variant allows slash-command starts). */
  initialPayload?: TransportSendPayload;
  initialMessageId?: string;
};

type SessionManagerConfig = {
  store: JotaiStore;
  resolveSession: (kiloSessionId: KiloSessionId) => Promise<ResolvedSession>;
  getTicket: (
    sessionId: CloudAgentSessionId
  ) => CloudAgentStreamTicketResult | Promise<CloudAgentStreamTicketResult>;
  fetchSnapshot: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  /**
   * Page-aware root snapshot fetch. Called by transports for the initial
   * bounded load and by the manager for `loadOlderMessages`. Optional so the
   * legacy `fetchSnapshot`-only path keeps working for callers that haven't
   * migrated to the paginated endpoint yet (e.g. server-side, tests). The
   * mobile adapter is the canonical provider.
   */
  fetchSnapshotPage?: (
    kiloSessionId: KiloSessionId,
    options: { cursor?: string }
  ) => Promise<SessionSnapshotPageOutcome | null>;
  websocketBaseUrl?: string;
  userWebConnection: UserWebConnection;
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
  /**
   * Optional sink for tool attachment bytes, called just before the chat
   * processor strips a completed tool part's attachment data URLs for storage.
   *
   * - Images (any tool): emitted unchanged.
   * - Non-images: emitted only when `part.tool === 'send_file'`.
   *
   * Receives the raw data URL exactly once per processor pass; consumers use
   * it to persist bytes outside the in-memory store (e.g. mobile's
   * file-system cache). Web never passes it, so web behaviour is unchanged.
   */
  onToolAttachment?: (
    partId: string,
    attachment: { mime: string; filename?: string; dataUrl: string }
  ) => void;
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
  /** Active resolved transport can deliver canonical Cloud Agent attachments. */
  supportsAttachments: W<boolean>;
  activeSessionType: W<ActiveSessionType | null>;
  remoteModelState: W<RemoteModelState>;
  remoteCommandState: W<RemoteCommandState>;
  observedModel: W<ModelSelection | null>;
  remoteModelOverride: W<RemoteModelOverride | null>;
  /** Session-scoped cloud-agent model pick; cleared on switchSession. Not remote. */
  cloudAgentModelOverride: W<CloudAgentModelOverride | null>;
  canSend: W<boolean>;
  canInterrupt: W<boolean>;
  statusIndicator: W<SessionStatusIndicator | null>;
  error: W<string | null>;
  question: W<QuestionState | null>;
  activeQuestion: W<StandaloneQuestion | null>;
  activePermission: W<StandalonePermission | null>;
  /** Every pending question, oldest first. `activeQuestion` is the head. */
  pendingQuestions: W<readonly StandaloneQuestion[]>;
  /** Every pending permission, oldest first. `activePermission` is the head. */
  pendingPermissions: W<readonly StandalonePermission[]>;
  activeSuggestion: W<StandaloneSuggestion | null>;
  sessionInfo: W<SessionInfo | null>;
  sessionId: W<CloudAgentSessionId | null>;
  activity: W<SessionActivity>;
  agentStatus: W<AgentStatus>;
  cloudStatus: W<CloudStatus | null>;
  setupLog: W<readonly string[]>;
  preparationAttempts: W<readonly PreparationAttempt[]>;
  sessionConfig: W<SessionConfig | null>;
  sessionType: W<ActiveSessionType | null>;
  chatUI: W<{ shouldAutoScroll: boolean }>;
  permission: W<PermissionState | null>;
  suggestion: W<SuggestionState | null>;
  pendingMessages: W<ReadonlyMap<string, MessageDeliveryState>>;
  failedPrompt: W<string | null>;
  fetchedSessionData: W<FetchedSessionData | null>;
  /** Slash command catalog reported by the wrapper for the current session. */
  availableCommands: W<SlashCommandInfo[]>;
  messagesList: Atom<StoredMessage[]>;
  staticMessages: Atom<StoredMessage[]>;
  dynamicMessages: Atom<StoredMessage[]>;
  totalCost: Atom<number>;
  contextUsage: Atom<ContextUsage | undefined>;
  childMessages: Atom<(childSessionId: string) => StoredMessage[]>;
  childSessionHydrationState: Atom<(childSessionId: string) => ChildSessionHydrationState>;
  /** True when the latest page left a non-null cursor (more history to load). */
  hasOlderMessages: W<boolean>;
  /** True while `loadOlderMessages()` is fetching a page. */
  isLoadingOlderMessages: W<boolean>;
  /** Typed failure from the most recent older-messages load. */
  olderMessagesError: W<OlderMessagesError | null>;
  /** Total items omitted across every page loaded so far (initial + older). */
  olderMessagesOmittedItemCount: W<number>;
  /**
   * True after `/clear` this visit until the first successful post-clear
   * `send()`, switch, or destroy. While set: older-page loads are blocked,
   * and reconnect replay purges everything except ids already in local
   * storage when the replay started (live post-clear turns). First successful
   * send clears the marker so a later reconnect shows full server history
   * (pre-clear messages may reappear — accepted tradeoff).
   */
  transcriptCleared: W<boolean>;
};

type SessionManager = {
  switchSession(kiloSessionId: KiloSessionId): Promise<void>;
  hydrateChildSession(childSessionId: KiloSessionId): Promise<void>;
  /**
   * Load the next page of older messages for the active session using the
   * stored cursor. Dedupes concurrent calls, never clears existing/live
   * messages, and classifies typed failures into `olderMessagesError`.
   * No-op when there is no cursor or a non-retryable terminal failure was
   * already surfaced for the active session.
   */
  loadOlderMessages(): Promise<void>;
  send(input: {
    payload: SessionManagerSendPayload;
    attachments?: CloudAgentAttachments;
    images?: Images;
    /**
     * Ready file parts to forward to a CAPABLE remote CLI session (the CLI
     * advertised `capabilities.attachments: true` in its most recent
     * heartbeat). Distinct from the cloud-only `attachments` field: cloud
     * sessions use `attachments`, remote sessions use `attachmentParts`.
     * Session-manager enforces the gate — a non-null payload for a
     * non-capable session is rejected with a typed error before it can
     * reach the transport.
     */
    attachmentParts?: RemoteAttachmentPart[];
  }): Promise<boolean>;
  setRemoteModelOverride(override: RemoteModelOverride | null): void;
  setCloudAgentModelOverride(override: CloudAgentModelOverride | null): void;
  retryRemoteModels(): void;
  retryRemoteCommands(): void;
  createRemoteSession(input?: CreateRemoteSessionInput): Promise<KiloSessionId>;
  exitRemoteSession(): Promise<void>;
  interrupt(): Promise<void>;
  /**
   * Clear the active session's local transcript view only. Server-side history
   * is untouched and reappears on re-entry (`switchSession`). No-op without an
   * active session.
   */
  clearTranscript(): void;
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

const GENERIC_ERROR = 'Something went wrong. Please retry in a moment.';
const SELECTED_MODEL_UNAVAILABLE_MESSAGE =
  'selected model is not available for this cloud agent session';
const SELECTED_MODEL_UNAVAILABLE_ERROR =
  'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.';

function isSelectedModelUnavailable(message: string | undefined): boolean {
  return message?.toLowerCase().includes(SELECTED_MODEL_UNAVAILABLE_MESSAGE) ?? false;
}

function formatError(err: unknown): string {
  const r = errorShapeSchema.safeParse(err);
  if (r.success) {
    if (isSelectedModelUnavailable(r.data.message)) return SELECTED_MODEL_UNAVAILABLE_ERROR;
    const code = r.data.data?.code ?? r.data.shape?.code;
    const http = r.data.data?.httpStatus ?? r.data.shape?.data?.httpStatus;
    if (code === 'PAYMENT_REQUIRED' || http === 402)
      return 'Insufficient credits. Please add at least $1 to continue using Cloud Agent.';
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN')
      return 'You are not authorized to use the Cloud Agent.';
    if (code === 'NOT_FOUND') return 'Service is unavailable right now. Please try again.';
    if (code === 'CONFLICT' || http === 409)
      return 'Previous task is still finishing up. Please wait a moment.';
    if (code === 'SERVICE_UNAVAILABLE' || http === 503)
      return 'Service is temporarily unavailable. Please retry in a moment.';
    if (code !== undefined || http !== undefined) {
      return GENERIC_ERROR;
    }
    // `errorShapeSchema` uses `.passthrough()`, so `safeParse` succeeds on any
    // object — including plain `Error` instances whose own properties satisfy
    // the schema vacuously. Fall through to the transport-level checks below
    // when neither `code` nor `httpStatus` is present so genuine connection
    // failures keep their existing wording.
  }
  if (err instanceof Error) {
    if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed'))
      return 'Connection lost. Please retry in a moment.';
    return 'Connection failed. Please retry in a moment.';
  }
  return GENERIC_ERROR;
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

function toModelSelection(model: ModelRef, variant?: string): ModelSelection {
  return { model, ...(variant ? { variant } : {}) };
}

function modelSelectionsEqual(a: ModelSelection | null, b: ModelSelection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return modelRefsEqual(a.model, b.model) && a.variant === b.variant;
}

function upsertPendingRequest<T extends { requestId: string }>(
  list: readonly T[],
  next: T
): readonly T[] {
  const index = list.findIndex(entry => entry.requestId === next.requestId);
  if (index === -1) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

function removePendingRequest<T extends { requestId: string }>(
  list: readonly T[],
  requestId: string
): readonly T[] {
  return list.some(entry => entry.requestId === requestId)
    ? list.filter(entry => entry.requestId !== requestId)
    : list;
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
  const supportsAttachmentsAtom = atom(false);
  const activeSessionTypeAtom = atom<ActiveSessionType | null>(null);
  const remoteModelStateAtom = atom<RemoteModelState>(EMPTY_REMOTE_MODEL_STATE);
  const remoteCommandStateAtom = atom<RemoteCommandState>(EMPTY_REMOTE_COMMAND_STATE);
  const observedModelAtom = atom<ModelSelection | null>(null);
  const remoteModelOverrideAtom = atom<RemoteModelOverride | null>(null);
  const cloudAgentModelOverrideAtom = atom<CloudAgentModelOverride | null>(null);
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
  const setupLogAtom = atom<readonly string[]>([]);
  const preparationAttemptsAtom = atom<readonly PreparationAttempt[]>([]);
  const sessionConfigAtom = atom<SessionConfig | null>(null);
  const sessionTypeAtom = atom<ActiveSessionType | null>(null);
  const chatUIAtom = atom<{ shouldAutoScroll: boolean }>({ shouldAutoScroll: true });
  const activeQuestionAtom = atom<StandaloneQuestion | null>(null);
  const permissionAtom = atom<PermissionState | null>(null);
  const activePermissionAtom = atom<StandalonePermission | null>(null);
  const pendingQuestionsAtom = atom<readonly StandaloneQuestion[]>([]);
  const pendingPermissionsAtom = atom<readonly StandalonePermission[]>([]);
  const suggestionAtom = atom<SuggestionState | null>(null);
  const activeSuggestionAtom = atom<StandaloneSuggestion | null>(null);
  const pendingMessagesAtom = atom<ReadonlyMap<string, MessageDeliveryState>>(new Map());
  const failedPromptAtom = atom<string | null>(null);
  const fetchedSessionDataAtom = atom<FetchedSessionData | null>(null);
  /**
   * Catalog of kilo slash commands the wrapper has reported. Populated by
   * `commands.available` events sent on every /stream connect (cached in the
   * DO) and on every wrapper push. Empty list = wrapper hasn't reported yet.
   */
  const availableCommandsAtom = atom<SlashCommandInfo[]>([]);
  const childSessionHydrationStatesAtom = atom<Map<string, ChildSessionHydrationState>>(new Map());
  const hasOlderMessagesAtom = atom<boolean>(false);
  const isLoadingOlderMessagesAtom = atom<boolean>(false);
  const olderMessagesErrorAtom = atom<OlderMessagesError | null>(null);
  const olderMessagesOmittedItemCountAtom = atom<number>(0);
  const transcriptClearedAtom = atom(false);

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
  const contextUsageAtom = atom(get => findLatestContextUsage(get(messagesListAtom)));
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
  const childSessionHydrationStateAtom = atom(get => {
    const states = get(childSessionHydrationStatesAtom);
    return (childSessionId: string): ChildSessionHydrationState =>
      states.get(childSessionId) ?? IDLE_CHILD_SESSION_HYDRATION_STATE;
  });

  // Private mutable state
  let activeSessionId: KiloSessionId | null = null;
  let switchGeneration = 0;
  let currentSession: CloudAgentSession | null = null;
  let activeSessionType: ActiveSessionType | null = null;
  /**
   * Latest per-session capabilities reported by the live CLI transport's
   * `onTransportCapabilitiesChange` callback. Captured here so the
   * `supportsAttachments` gate can be recomputed on every heartbeat-driven
   * capability change (upgrade, downgrade, reconnect, absent) — not only at
   * the initial `onResolved` moment. `undefined` means the CLI has not
   * reported any (older CLIs, mid-reconnect, or a session that the active
   * CLI no longer claims).
   */
  let currentCapabilities: { attachments?: boolean } | undefined = undefined;
  let observedModelSource: ObservedModelSource | null = null;
  // True while a connect/reconnect cycle is still replaying its message
  // history; false once live events are flowing. See clearOverrideIfDiverged.
  let remoteHistoryReplaying = true;
  /**
   * Session captured at the start of an interrupt call. While non-null, an
   * `onError("Aborted")` from this session is suppressed — it was produced by
   * the manager's own `interrupt()`. A real transport error or an Aborted from
   * a different/late session still sets errorAtom normally.
   */
  let pendingInterruptSession: CloudAgentSession | null = null;
  /**
   * Message ids already in local storage when a reconnect replay starts while
   * `/clear` is active. Those are live post-clear turns for this visit and
   * must survive purge; everything else in the replayed snapshot is dropped.
   * Null when the marker is not set (no purge) or survivors were not
   * snapshotted (should not purge blindly).
   */
  let postClearSurvivorIds: ReadonlySet<string> | null = null;
  /**
   * After Stop ACK we force the composer unlocked. Remote `session.canSend`
   * can stay false while `ownerConnectionId` is briefly null; state.subscribe
   * would then re-lock via updateCapabilityAtoms. Hold the unlock until the
   * live gate recovers (or the session switches).
   */
  let postInterruptUnlock = false;
  let stateUnsub: (() => void) | null = null;
  let indicatorTimer: ReturnType<typeof setTimeout> | null = null;
  let childSessionHydrationGeneration = 0;
  const childSessionHydrationRequests = new Map<string, Promise<void>>();
  // Pagination state for `loadOlderMessages`. Reset on every switchSession.
  let olderMessagesCursor: string | null = null;
  // Monotonically increasing per-session generation; older-page results
  // whose `expectedLoadOlderGeneration` doesn't match are dropped.
  let loadOlderGeneration = 0;
  // In-flight older-page load, used to dedupe concurrent calls and to let
  // late callers await the same result.
  let olderMessagesInFlight: Promise<void> | null = null;
  // Once a non-retryable terminal failure lands, we permanently disable
  // further older-page loads for the active session.
  let olderMessagesTerminal: boolean = false;
  /**
   * Last non-empty `mode` from a remote prompt send. Used as agent inheritance
   * fallback when `sessionConfigAtom.mode` is absent/`''`. Reset on switch/destroy.
   */
  let lastPromptMode: string | null = null;

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
    store.set(supportsAttachmentsAtom, false);
    store.set(activeSessionTypeAtom, null);
    store.set(remoteModelStateAtom, EMPTY_REMOTE_MODEL_STATE);
    store.set(remoteCommandStateAtom, EMPTY_REMOTE_COMMAND_STATE);
    store.set(observedModelAtom, null);
    observedModelSource = null;
    remoteHistoryReplaying = true;
    postClearSurvivorIds = null;
    postInterruptUnlock = false;
    store.set(remoteModelOverrideAtom, null);
    store.set(cloudAgentModelOverrideAtom, null);
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
    store.set(setupLogAtom, []);
    store.set(preparationAttemptsAtom, []);
    store.set(sessionConfigAtom, null);
    store.set(sessionTypeAtom, null);
    store.set(activeQuestionAtom, null);
    store.set(permissionAtom, null);
    store.set(activePermissionAtom, null);
    store.set(pendingQuestionsAtom, []);
    store.set(pendingPermissionsAtom, []);
    store.set(suggestionAtom, null);
    store.set(activeSuggestionAtom, null);
    store.set(pendingMessagesAtom, new Map());
    store.set(failedPromptAtom, null);
    store.set(fetchedSessionDataAtom, null);
    store.set(childSessionHydrationStatesAtom, new Map());
    store.set(chatUIAtom, { shouldAutoScroll: true });
    store.set(availableCommandsAtom, []);
    store.set(hasOlderMessagesAtom, false);
    store.set(isLoadingOlderMessagesAtom, false);
    store.set(olderMessagesErrorAtom, null);
    store.set(olderMessagesOmittedItemCountAtom, 0);
    store.set(transcriptClearedAtom, false);
    olderMessagesCursor = null;
    loadOlderGeneration += 1;
    olderMessagesInFlight = null;
    lastPromptMode = null;
    olderMessagesTerminal = false;
    currentCapabilities = undefined;
    pendingInterruptSession = null;
  }

  function setChildSessionHydrationState(
    childSessionId: KiloSessionId,
    state: ChildSessionHydrationState
  ): void {
    const next = new Map(store.get(childSessionHydrationStatesAtom));
    next.set(childSessionId, state);
    store.set(childSessionHydrationStatesAtom, next);
  }

  function isCurrentChildSessionHydration(
    generation: number,
    rootSessionId: KiloSessionId,
    storage: JotaiSessionStorage
  ): boolean {
    return (
      generation === childSessionHydrationGeneration &&
      activeSessionId === rootSessionId &&
      store.get(sessionStorageAtom) === storage
    );
  }

  async function hydrateChildSession(childSessionId: KiloSessionId): Promise<void> {
    const existingState = store.get(childSessionHydrationStatesAtom).get(childSessionId);
    if (existingState?.status === 'ready') return;

    const inFlightRequest = childSessionHydrationRequests.get(childSessionId);
    if (inFlightRequest) {
      await inFlightRequest;
      return;
    }

    const storage = store.get(sessionStorageAtom);
    const rootSessionId = activeSessionId;
    if (!storage || !rootSessionId) return;

    const generation = childSessionHydrationGeneration;
    setChildSessionHydrationState(childSessionId, { status: 'loading' });

    const request = (async () => {
      try {
        const snapshot = await config.fetchSnapshot(childSessionId);
        if (!isCurrentChildSessionHydration(generation, rootSessionId, storage)) return;

        const chatProcessor = createChatProcessor(storage, {
          onToolAttachment: config.onToolAttachment,
        });
        for (const message of snapshot.messages) {
          chatProcessor.process({ type: 'message.updated', info: message.info });
          for (const part of message.parts) {
            chatProcessor.process({ type: 'message.part.updated', part });
          }
        }

        setChildSessionHydrationState(childSessionId, { status: 'ready' });
      } catch (err) {
        if (!isCurrentChildSessionHydration(generation, rootSessionId, storage)) return;
        setChildSessionHydrationState(childSessionId, {
          status: 'error',
          message: formatError(err),
        });
      }
    })();

    childSessionHydrationRequests.set(childSessionId, request);
    try {
      await request;
    } finally {
      if (childSessionHydrationRequests.get(childSessionId) === request) {
        childSessionHydrationRequests.delete(childSessionId);
      }
    }
  }

  function updateCapabilityAtoms(session: CloudAgentSession): void {
    const cloudStatus = store.get(cloudStatusAtom);
    const cloudReady = cloudStatus === null || cloudStatus.type === 'ready';
    const liveCanSend = session.canSend && cloudReady;
    if (postInterruptUnlock) {
      if (liveCanSend) {
        postInterruptUnlock = false;
        store.set(canSendAtom, true);
      } else {
        // Keep composer editable while the remote owner reconverges.
        // Latch is never armed for read-only sessions.
        store.set(canSendAtom, cloudReady);
      }
    } else {
      store.set(canSendAtom, liveCanSend);
    }
    store.set(canInterruptAtom, session.canInterrupt);
  }

  /**
   * Recompute the `supportsAttachments` gate for the active session. Called
   * on every `onResolved` (initial resolution) AND every
   * `onTransportCapabilitiesChange` (heartbeat upgrade/downgrade/reconnect/
   * absent) so the UI gate tracks the CLI's most recent advertisement.
   *
   * Rules:
   *  - `cloud-agent`: always supports attachments (S3a is a no-op for
   *    cloud-agent sessions, but cloud-agent attachments flow through
   *    the existing `attachments` field, not the new `attachmentParts`).
   *  - `remote`: supports attachments only when the live CLI reported
   *    `capabilities.attachments === true` in its most recent heartbeat
   *    or `sessions.list`. Any other state (absent, false, mid-reconnect)
   *    → `false`, matching today's "no paperclip" parity for non-capable
   *    remote sessions.
   *  - `read-only`: never supports attachments.
   */
  function recomputeSupportsAttachments(sessionType: ActiveSessionType | null): void {
    let supports: boolean;
    if (sessionType === 'cloud-agent') {
      supports = true;
    } else if (sessionType === 'remote') {
      supports = currentCapabilities?.attachments === true;
    } else {
      supports = false;
    }
    store.set(supportsAttachmentsAtom, supports);
  }

  function updateObservedModel(model: ModelSelection, source: ObservedModelSource): void {
    observedModelSource = source;
    // Only churn the atom when the selection actually changes: the incoming
    // object is freshly built on every message.updated, so a reference check
    // never holds and would needlessly rebuild the whole model-options list.
    if (!modelSelectionsEqual(store.get(observedModelAtom), model)) {
      store.set(observedModelAtom, model);
    }
  }

  // A web-picked override should stop applying once we see live proof the
  // CLI actually ran a message on a different model or variant — otherwise
  // the picker gets stuck showing a choice that's no longer what's being
  // sent, and `send()` keeps re-applying a stale variant. Gated on
  // `remoteHistoryReplaying` so a reconnect's replayed history (which can
  // predate the override) can't wipe a selection that just hasn't been used
  // yet.
  function clearOverrideIfDiverged(model: ModelSelection): void {
    if (remoteHistoryReplaying) return;
    const override = store.get(remoteModelOverrideAtom);
    if (override && !modelSelectionsEqual(override.selection, model)) {
      store.set(remoteModelOverrideAtom, null);
    }
  }

  function handleRemoteModelStateChange(state: RemoteModelState): void {
    const previousOwnerConnectionId = store.get(remoteModelStateAtom).ownerConnectionId;
    store.set(remoteModelStateAtom, state);

    if (previousOwnerConnectionId !== state.ownerConnectionId) {
      store.set(remoteModelOverrideAtom, null);
      if (observedModelSource === 'catalog') {
        observedModelSource = null;
        store.set(observedModelAtom, null);
      }
    } else {
      const override = store.get(remoteModelOverrideAtom);
      const sourceMatchesProtocol =
        (state.protocol === 'v1' && override?.source === 'cli-catalog') ||
        (state.protocol === 'legacy' && override?.source === 'legacy-gateway');
      const provider = state.catalog?.providers.find(
        item => item.id === override?.selection.model.providerID
      );
      const catalogModel = provider?.models.find(
        item => item.id === override?.selection.model.modelID
      );
      const modelMatchesProtocol =
        state.protocol === 'v1'
          ? catalogModel !== undefined
          : state.protocol === 'legacy' && override?.selection.model.providerID === 'kilo';
      if (override && (!sourceMatchesProtocol || !modelMatchesProtocol)) {
        store.set(remoteModelOverrideAtom, null);
      } else if (
        override?.source === 'cli-catalog' &&
        override.selection.variant &&
        catalogModel &&
        !catalogModel.variants.includes(override.selection.variant)
      ) {
        store.set(remoteModelOverrideAtom, {
          source: 'cli-catalog',
          selection: { model: override.selection.model },
        });
      }
    }
    if (
      (observedModelSource === null || observedModelSource === 'catalog') &&
      state.catalog?.currentModel
    ) {
      updateObservedModel(state.catalog.currentModel, 'catalog');
    }
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
      const previousStatus = store.get(agentStatusAtom);
      store.set(activityAtom, act);
      if (!firstActivityFired && act.type !== 'connecting') {
        firstActivityFired = true;
        opts?.onFirstActivity?.();
      }
      store.set(agentStatusAtom, st);
      store.set(cloudStatusAtom, cs);
      store.set(setupLogAtom, session.state.getSetupLog());
      store.set(
        preparationAttemptsAtom,
        'getPreparationAttempts' in session.state ? session.state.getPreparationAttempts() : []
      );
      store.set(isStreamingAtom, act.type === 'busy');
      store.set(questionAtom, session.state.getQuestion());
      store.set(permissionAtom, session.state.getPermission());
      store.set(suggestionAtom, session.state.getSuggestion());
      store.set(sessionInfoAtom, session.state.getSessionInfo());
      store.set(pendingMessagesAtom, new Map(session.state.getPendingMessages()));

      // Disconnect clears the interrupt unlock latch so normal
      // (!session.canSend) semantics take over for unresolved/null sessions.
      if (st.type === 'disconnected') {
        postInterruptUnlock = false;
      }

      // Only update read-only state after the transport has been resolved.
      // During the 'connecting' phase the transport is null so canSend is
      // always false, which would briefly flash a "read-only" banner.
      if (act.type !== 'connecting') {
        if (postInterruptUnlock && activeSessionType !== 'read-only') {
          store.set(isReadOnlyAtom, false);
        } else {
          store.set(
            isReadOnlyAtom,
            activeSessionType === null ? !session.canSend : activeSessionType === 'read-only'
          );
        }
      }
      updateCapabilityAtoms(session);

      if (previousStatus.type === 'disconnected' && st.type !== 'disconnected') {
        store.set(errorAtom, null);
        setIndicator(null);
      }

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

  // Replay a `SessionSnapshotPageOutcome` into the active storage. Returns
  // whether the page was applied (so the caller can also persist the cursor
  // and atom updates). Generation-aware: a stale caller's result is
  // discarded silently. Used by both `switchSession` (initial page) and
  // `loadOlderMessages` (subsequent pages).
  function applyPage(outcome: SessionSnapshotPageOutcome, expectedGeneration: number): boolean {
    if (expectedGeneration !== loadOlderGeneration) return false;
    if (outcome.kind !== 'success') return false;

    // Defense-in-depth: a stale or mismatched page must not overwrite the
    // active session's messages or cursor. This catches races where a
    // fetchSnapshotPage result arrives after switchSession has retargeted the
    // manager to a different session.
    if (activeSessionId === null || outcome.info.id !== activeSessionId) return false;

    const storage = store.get(sessionStorageAtom);
    if (!storage) return false;

    const chatProcessor = createChatProcessor(storage, {
      onToolAttachment: config.onToolAttachment,
    });
    for (const message of outcome.messages) {
      chatProcessor.process({ type: 'message.updated', info: message.info });
      for (const part of message.parts) {
        chatProcessor.process({ type: 'message.part.updated', part });
      }
    }

    olderMessagesCursor = outcome.nextCursor;
    store.set(hasOlderMessagesAtom, outcome.nextCursor !== null);
    store.set(
      olderMessagesOmittedItemCountAtom,
      store.get(olderMessagesOmittedItemCountAtom) + outcome.omittedItemCount
    );
    store.set(olderMessagesErrorAtom, null);
    return true;
  }

  async function loadOlderMessages(): Promise<void> {
    // Terminal failures block any further backend hits until the next
    // switchSession (which resets `olderMessagesTerminal`).
    if (olderMessagesTerminal) return;
    // `/clear` keeps the local view empty for this visit — do not page history back in.
    if (store.get(transcriptClearedAtom)) return;
    // No cursor means nothing left to load.
    if (olderMessagesCursor === null) return;
    // Dedupe: if a load is already in flight, every caller awaits the
    // same result instead of starting a parallel backend request.
    if (olderMessagesInFlight) return olderMessagesInFlight;

    const kiloSessionId = activeSessionId;
    if (!kiloSessionId) return;
    if (!config.fetchSnapshotPage) return;
    const fetchSnapshotPage = config.fetchSnapshotPage;

    const cursor = olderMessagesCursor;
    const expectedGeneration = loadOlderGeneration;

    const loadPromise = (async (): Promise<void> => {
      store.set(isLoadingOlderMessagesAtom, true);
      let outcome: SessionSnapshotPageOutcome | null;
      try {
        outcome = await fetchSnapshotPage(kiloSessionId, { cursor });
      } catch (_err) {
        // Network/transport-level failures map to a retryable outcome so
        // the UI exposes a Retry CTA. The cursor is preserved.
        if (expectedGeneration !== loadOlderGeneration) return;
        store.set(olderMessagesErrorAtom, { kind: 'retryable' });
        store.set(isLoadingOlderMessagesAtom, false);
        return;
      }
      if (expectedGeneration !== loadOlderGeneration) return;

      if (outcome === null) {
        // Access-not-found (worker 404). Treat as terminal; the session
        // is no longer readable.
        olderMessagesTerminal = true;
        store.set(olderMessagesErrorAtom, { kind: 'invalid_data' });
        store.set(hasOlderMessagesAtom, false);
        store.set(isLoadingOlderMessagesAtom, false);
        return;
      }

      if (outcome.kind === 'success') {
        applyPage(outcome, expectedGeneration);
        store.set(isLoadingOlderMessagesAtom, false);
        return;
      }

      if (outcome.kind === 'retryable_failure') {
        store.set(olderMessagesErrorAtom, { kind: 'retryable' });
        // Keep the cursor so a subsequent retry continues from here.
        store.set(isLoadingOlderMessagesAtom, false);
        return;
      }

      // `invalid_data` and `too_large` are non-retryable terminal states:
      // don't auto-hide the older loader (the user may want to see the
      // banner), and don't accept further loads for this session.
      olderMessagesTerminal = true;
      store.set(olderMessagesErrorAtom, { kind: outcome.kind });
      store.set(hasOlderMessagesAtom, false);
      store.set(isLoadingOlderMessagesAtom, false);
    })();

    olderMessagesInFlight = loadPromise;
    try {
      await loadPromise;
    } finally {
      if (olderMessagesInFlight === loadPromise) {
        olderMessagesInFlight = null;
      }
    }
  }

  async function switchSession(kiloSessionId: KiloSessionId): Promise<void> {
    childSessionHydrationGeneration += 1;
    childSessionHydrationRequests.clear();
    switchGeneration += 1;
    const expectedGeneration = switchGeneration;
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
      if (expectedGeneration !== switchGeneration) return;
      store.set(isLoadingAtom, false);
      setIndicator({ type: 'error', message: formatError(err), timestamp: Date.now() });
      return;
    }
    if (expectedGeneration !== switchGeneration) return;
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
      providerID: null,
      variant: data.variant ?? null,
      runtimeAgents: data.runtimeAgents,
    });
    store.set(sessionIdAtom, data.cloudAgentSessionId);

    config.onKiloSessionCreated?.(kiloSessionId);

    // Persist the bounded page's cursor / hasOlderMessages / omittedItemCount
    // so `loadOlderMessages` can continue from where the transport left off.
    // This is a no-op for stale (pre-switchSession) callbacks because
    // `loadOlderGeneration` advances on every switch. The generation is
    // captured synchronously here, at callback creation time: reading
    // `loadOlderGeneration` from inside the callback would be tautological
    // when the same session id is switched twice in a row, because the
    // second switch's `clearAllAtoms()` advance lands before the first
    // switch's `onInitialPageLoaded` callback runs, letting a stale page
    // pass the generation check and clobber the active session's cursor
    // and omitted-item count.
    const initialPageGeneration = loadOlderGeneration;
    const recordInitialPage = (page: SessionSnapshotPage): void => {
      applyPage({ ...page, kind: 'success' }, initialPageGeneration);
    };

    const session = createCloudAgentSession({
      kiloSessionId,
      resolveSession: config.resolveSession,
      transport: {
        getTicket: config.getTicket,
        api: config.api,
        fetchSnapshot: config.fetchSnapshot,
        ...(config.fetchSnapshotPage ? { fetchSnapshotPage: config.fetchSnapshotPage } : {}),
        onInitialPageLoaded: recordInitialPage,
        userWebConnection: config.userWebConnection,
        lifecycleHooks: config.lifecycleHooks,
        websocketHeaders: config.websocketHeaders,
      },
      websocketBaseUrl: config.websocketBaseUrl,
      storage: jotaiStorage,
      onToolAttachment: config.onToolAttachment,
      onSessionCreated: info => {
        if (info.parentID == null) {
          // Adopt the server-reported root session ID so message
          // filtering works even when switchSession was called with a
          // cast cloudAgentSessionId (the createAndStart path).
          store.set(rootSessionIdAtom, info.id);
          store.set(isLoadingAtom, false);
          // A fresh replay is starting (initial connect or a reconnect);
          // onReplayComplete flips this back off once it's done.
          remoteHistoryReplaying = true;
          // Snapshot live post-clear ids before snapshot upserts land.
          postClearSurvivorIds = store.get(transcriptClearedAtom)
            ? new Set(session.storage.getMessageIds())
            : null;
          if (info.model) {
            updateObservedModel(
              toModelSelection(
                { providerID: info.model.providerID, modelID: info.model.id },
                info.model.variant
              ),
              'session'
            );
          }
        }
      },

      onSessionUpdated: info => {
        const rootSessionId = store.get(rootSessionIdAtom);
        if (rootSessionId === info.id && info.model) {
          updateObservedModel(
            toModelSelection(
              { providerID: info.model.providerID, modelID: info.model.id },
              info.model.variant
            ),
            'session'
          );
        }
      },
      onQuestionAsked: (requestId, questions) => {
        if (!questions) return;
        const next = upsertPendingRequest(store.get(pendingQuestionsAtom), {
          requestId,
          questions,
        });
        store.set(pendingQuestionsAtom, next);
        store.set(activeQuestionAtom, next[0] ?? null);
      },
      onQuestionResolved: requestId => {
        const next = removePendingRequest(store.get(pendingQuestionsAtom), requestId);
        store.set(pendingQuestionsAtom, next);
        store.set(activeQuestionAtom, next[0] ?? null);
      },
      onPermissionAsked: (requestId, permission, patterns, metadata, always) => {
        if (!permission) return;
        const next = upsertPendingRequest(store.get(pendingPermissionsAtom), {
          requestId,
          permission,
          patterns: patterns ?? [],
          metadata: metadata ?? {},
          always: always ?? [],
        });
        store.set(pendingPermissionsAtom, next);
        store.set(activePermissionAtom, next[0] ?? null);
      },
      onPermissionResolved: requestId => {
        const next = removePendingRequest(store.get(pendingPermissionsAtom), requestId);
        store.set(pendingPermissionsAtom, next);
        store.set(activePermissionAtom, next[0] ?? null);
      },
      onSuggestionAsked: (requestId, text, actions, callId) => {
        store.set(activeSuggestionAtom, { requestId, text, actions, callId });
      },
      onSuggestionResolved: requestId => {
        const as = store.get(activeSuggestionAtom);
        if (as?.requestId === requestId) store.set(activeSuggestionAtom, null);
      },
      onResolved: resolved => {
        activeSessionType = resolved.type;
        store.set(sessionTypeAtom, resolved.type);
        store.set(activeSessionTypeAtom, resolved.type);
        // Seed capabilities from the resolved session so the initial gate
        // reflects whatever the mobile-side `resolveSession` adapter had
        // to work with (e.g. the current `activeSessions.list` snapshot).
        // Subsequent heartbeat changes arrive via `onTransportCapabilitiesChange`
        // and overwrite this.
        currentCapabilities = resolved.type === 'remote' ? resolved.capabilities : undefined;
        recomputeSupportsAttachments(resolved.type);
        updateCapabilityAtoms(session);
      },
      onRemoteModelStateChange: handleRemoteModelStateChange,
      onRemoteCommandStateChange: state => {
        if (expectedGeneration !== switchGeneration) return;
        store.set(remoteCommandStateAtom, state);
      },
      onTransportCapabilityChange: () => {
        if (expectedGeneration !== switchGeneration) return;
        if (currentSession === session) updateCapabilityAtoms(session);
      },
      onTransportCapabilitiesChange: capabilities => {
        if (expectedGeneration !== switchGeneration) return;
        currentCapabilities = capabilities;
        recomputeSupportsAttachments(activeSessionType);
      },
      onReplayComplete: () => {
        if (expectedGeneration !== switchGeneration) return;
        remoteHistoryReplaying = false;
        store.set(isLoadingAtom, false);
        // `/clear` with no successful post-clear send: drop the replayed
        // snapshot down to live post-clear ids only. No id/timestamp
        // comparison across hosts — survivors were local when replay started.
        // First successful send clears the marker, so this path does not run
        // after the user continues the conversation.
        const survivors = postClearSurvivorIds;
        postClearSurvivorIds = null;
        if (!store.get(transcriptClearedAtom) || survivors === null) return;
        for (const messageId of session.storage.getMessageIds()) {
          if (!survivors.has(messageId)) {
            session.storage.deleteMessage(messageId);
          }
        }
      },

      onBranchChanged: branch => {
        const currentFetched = store.get(fetchedSessionDataAtom);
        if (currentFetched) {
          store.set(fetchedSessionDataAtom, { ...currentFetched, gitBranch: branch });
        }
        config.onBranchChanged?.(branch);
      },
      onError: message => {
        // Suppress the one-shot "Aborted" produced by this manager's own
        // interrupt() call. The service emits this after a user-initiated
        // Stop, and the interrupt path already handles composer unlock +
        // indicator. Letting it through to errorAtom would disable the
        // composer despite canSend being correctly restored by
        // restoreAfterInterrupt. The guard is consumed on match (one-shot) so
        // unrelated or subsequent Aborted events still surface.
        if (message === 'Aborted' && pendingInterruptSession === session) {
          pendingInterruptSession = null;
          return;
        }
        store.set(errorAtom, message);
      },
      onMessageFailed: (_messageId, deliveryState) => {
        if (deliveryState.reason !== 'exhausted') return;
        setIndicator({
          type: 'error',
          message: 'Message failed to deliver',
          timestamp: Date.now(),
        });
      },
      onEvent: event => {
        if (expectedGeneration !== switchGeneration) return;
        if (event.type === 'commands.available') {
          // Replace the catalog wholesale. The DO sends the full list on
          // every connect, so we never need to merge incrementally.
          store.set(availableCommandsAtom, event.commands);
          return;
        }
        if (event.type === 'message.updated') {
          const rootSessionId = store.get(rootSessionIdAtom);
          if (rootSessionId !== null && event.info.sessionID !== rootSessionId) return;

          // A live message always wins: it's the freshest, most specific proof
          // of what model actually ran for this turn, more reliable than
          // `session.updated` (which can lag behind or never fire for a
          // per-request override that doesn't change the session's persisted
          // default). During the initial replay, only suppress this when
          // `session.created` already claimed a value for this connect cycle
          // — its snapshot-time value is fresher than an older replayed
          // message, but if it never had a model to begin with there's
          // nothing fresher to protect.
          const canApplyMessageObservation =
            !remoteHistoryReplaying || observedModelSource !== 'session';
          if (event.info.role === 'user') {
            if (canApplyMessageObservation) {
              const selection = toModelSelection(event.info.model, event.info.variant);
              updateObservedModel(selection, 'message');
              clearOverrideIfDiverged(selection);
            }
            return;
          }

          if (canApplyMessageObservation) {
            const selection = toModelSelection(
              { providerID: event.info.providerID, modelID: event.info.modelID },
              event.info.variant
            );
            updateObservedModel(selection, 'message');
            clearOverrideIfDiverged(selection);
          }

          // `info.agent` is the agent slug (e.g. 'code', 'e-code'); `info.mode`
          // is the visibility ('primary'|'subagent'|'all') and must not be used
          // as the picker's selected mode.
          const currentConfig = store.get(sessionConfigAtom);
          if (
            currentConfig &&
            (currentConfig.model !== event.info.modelID ||
              currentConfig.providerID !== event.info.providerID ||
              currentConfig.mode !== event.info.agent ||
              currentConfig.variant !== (event.info.variant ?? null))
          ) {
            store.set(sessionConfigAtom, {
              ...currentConfig,
              model: event.info.modelID,
              providerID: event.info.providerID,
              mode: event.info.agent,
              variant: event.info.variant ?? null,
            });
          }
        }
      },
    });

    if (expectedGeneration !== switchGeneration) {
      session.destroy();
      return;
    }
    currentSession = session;
    subscribeToServiceState(session, {
      onFirstActivity: () => {
        // Fallback: clear loading when events flow even if no root
        // session.created was replayed (e.g. CLI snapshot failure).
        // While a remote session's initial history replay is in flight,
        // onReplayComplete owns the clear; clearing here would flash the
        // empty state before replayed messages land.
        if (!(activeSessionType === 'remote' && remoteHistoryReplaying)) {
          store.set(isLoadingAtom, false);
        }
        if (activeSessionType === 'remote') {
          config.onRemoteSessionOpened?.({ kiloSessionId });
        }
      },
    });
    session.connect();
  }

  async function send(input: {
    payload: SessionManagerSendPayload;
    attachments?: CloudAgentAttachments;
    images?: Images;
    attachmentParts?: RemoteAttachmentPart[];
  }): Promise<boolean> {
    store.set(errorAtom, null);
    if (store.get(agentStatusAtom).type !== 'disconnected') {
      setIndicator(null);
    }

    // Snapshot before any await — switchSession() can retarget activeSessionId
    // and activeSessionType while send is in flight; we need the values that
    // were current when the user pressed send, not the post-switch ones.
    const kiloSessionId = activeSessionId;
    const sessionType = activeSessionType;

    // Client-side `/clear` for remote sessions: clear the local transcript view
    // only; never hit the transport (Decision 3/4).
    if (
      sessionType === 'remote' &&
      input.payload.type === 'command' &&
      input.payload.command === 'clear' &&
      input.payload.arguments === ''
    ) {
      clearTranscript();
      return true;
    }

    const messageId = generateMessageId();
    const messageText =
      input.payload.type === 'command'
        ? `/${input.payload.command}${input.payload.arguments ? ` ${input.payload.arguments}` : ''}`
        : input.payload.prompt;
    const remoteModelOverride = store.get(remoteModelOverrideAtom);
    const cloudAgentModelOverride = store.get(cloudAgentModelOverrideAtom);
    let transportPayload: TransportSendPayload;
    if (input.payload.type === 'command') {
      transportPayload = input.payload;
    } else if (sessionType === 'remote') {
      // Capture mode for `/new` agent inheritance (Decision 6).
      if (input.payload.mode) {
        lastPromptMode = input.payload.mode;
      }
      transportPayload = {
        type: 'prompt',
        prompt: input.payload.prompt,
        ...(input.payload.mode ? { mode: input.payload.mode } : {}),
        ...(remoteModelOverride
          ? {
              model: remoteModelOverride.selection.model,
              ...(remoteModelOverride.selection.variant
                ? { variant: remoteModelOverride.selection.variant }
                : {}),
            }
          : {}),
      };
    } else {
      // Prefer the in-session cloud-agent override over the payload so a stale
      // composer model cannot bypass the manager's single source of truth.
      const cloudModel = cloudAgentModelOverride?.model ?? input.payload.model;
      const cloudVariant = cloudAgentModelOverride
        ? cloudAgentModelOverride.variant
        : input.payload.variant;
      transportPayload = {
        type: 'prompt',
        prompt: input.payload.prompt,
        ...(input.payload.mode ? { mode: input.payload.mode } : {}),
        ...(cloudModel ? { model: { providerID: 'kilo', modelID: cloudModel } } : {}),
        ...(cloudModel && cloudVariant ? { variant: cloudVariant } : {}),
      };
    }

    try {
      if (!currentSession) throw new Error('No active session');
      if (input.attachments && sessionType !== 'cloud-agent') {
        // The cloud-only `attachments` field is exclusive to cloud-agent
        // sessions. Remote CLI sessions (capable or not) go through the
        // new `attachmentParts` path. Reject loudly if a caller mixes them
        // up — this is a programmer error, not a user-recoverable state.
        throw new Error('Only Cloud Agent sessions support attachments');
      }
      if (input.attachmentParts && input.attachmentParts.length > 0) {
        if (sessionType !== 'remote' || currentCapabilities?.attachments !== true) {
          // A non-null `attachmentParts` for a non-capable session is a
          // UI-bug: the paperclip is supposed to be hidden whenever this
          // gate fails, so we should never see payload here. Refuse to
          // forward rather than silently drop — same policy as the
          // cloud-only branch above.
          throw new Error('Only capable remote CLI sessions support attachments');
        }
      }
      await currentSession.send({
        payload: transportPayload,
        messageId,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        images: input.images,
        ...(sessionType === 'remote' && remoteModelOverride ? { remoteModelOverride } : {}),
        ...(input.attachmentParts && input.attachmentParts.length > 0
          ? { attachmentParts: input.attachmentParts }
          : {}),
      });

      // User continued after `/clear`: drop the marker so a later reconnect
      // replays full history (pre-clear may reappear — accepted tradeoff).
      // Gate on the pre-await session id — a mid-flight switchSession + /clear
      // on B must not have A's resolving send clear B's marker.
      if (activeSessionId === kiloSessionId && store.get(transcriptClearedAtom)) {
        store.set(transcriptClearedAtom, false);
      }

      if (sessionType === 'remote' && kiloSessionId) {
        config.onRemoteSessionMessageSent?.({ kiloSessionId });
      }
      return true;
    } catch (err) {
      store.set(failedPromptAtom, messageText);
      const message = formatError(err);
      config.onSendFailed?.(messageText, message, err);
      if (store.get(agentStatusAtom).type !== 'disconnected') {
        setIndicator({ type: 'error', message, timestamp: Date.now() });
      }
      return false;
    }
  }

  /**
   * After Stop ACK, unlock the composer immediately. Remote `session.canSend`
   * keys on `ownerConnectionId`, which can briefly clear during the interrupt
   * round-trip (SESSION_OWNER_CHANGED / heartbeat race). Waiting on the next
   * heartbeat leaves the multiline TextInput non-editable (parent NotEnabled)
   * even though the CLI cancel already settled — Item 14 E2E gate. Sends while
   * the CLI is still winding down are queued CLI-side.
   */
  function restoreAfterInterrupt(session: CloudAgentSession): void {
    const cs = store.get(cloudStatusAtom);
    const cloudReady = cs === null || cs.type === 'ready';
    const readOnly = activeSessionType === 'read-only';
    postInterruptUnlock = !readOnly;
    store.set(isStreamingAtom, false);
    store.set(isReadOnlyAtom, readOnly);
    store.set(canSendAtom, !readOnly && cloudReady);
    store.set(canInterruptAtom, session.canInterrupt);
  }

  async function interrupt(): Promise<void> {
    if (!currentSession) return;
    // Snapshot before await — switchSession()/destroy() can swap currentSession while in flight.
    const session = currentSession;
    // Eagerly disable send/interrupt to prevent the user from sending a
    // message while the async interrupt HTTP call is in flight. We do NOT
    // call disconnect() — interrupt stops the agent but keeps the transport
    // alive so the user can continue the session.
    postInterruptUnlock = false;
    store.set(canSendAtom, false);
    store.set(canInterruptAtom, false);
    try {
      if (session.canInterrupt) {
        // Mark this session as the expected source of any "Aborted" error
        // so onError can suppress it without hiding real transport failures.
        pendingInterruptSession = session;
        await session.interrupt();
      }
      if (currentSession === session) {
        restoreAfterInterrupt(session);
        setIndicator({ type: 'info', message: 'Session stopped', timestamp: Date.now() });
      }
    } catch {
      if (currentSession === session) {
        // Prefer unlock over a stuck composer when the session is still writable.
        restoreAfterInterrupt(session);
        // Never poison errorAtom — that disables the composer. Use the
        // transient indicator instead (Item 14 / Decision 2).
        setIndicator({
          type: 'error',
          message: 'Failed to stop execution',
          timestamp: Date.now(),
        });
      }
    }
  }

  function clearTranscript(): void {
    if (!currentSession) return;
    currentSession.storage.clear();
    olderMessagesCursor = null;
    store.set(hasOlderMessagesAtom, false);
    // Same idle reset as clearAllAtoms: an in-flight older-page fetch will
    // hit the generation guard and return without clearing these atoms.
    store.set(isLoadingOlderMessagesAtom, false);
    store.set(olderMessagesErrorAtom, null);
    olderMessagesInFlight = null;
    loadOlderGeneration += 1;
    store.set(transcriptClearedAtom, true);
    store.set(chatUIAtom, { shouldAutoScroll: true });
    setIndicator({
      type: 'info',
      message: TRANSCRIPT_CLEARED_INDICATOR,
      timestamp: Date.now(),
    });
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
      const initialMessageId = input.initialMessageId ?? generateMessageId();
      const { cloudAgentSessionId, kiloSessionId } = await config.prepare({
        ...input,
        initialMessageId,
      });
      await config.initiate({ cloudAgentSessionId });
      store.set(sessionIdAtom, cloudAgentSessionId);
      await switchSession(kiloSessionId);
    } catch (err) {
      setIndicator({ type: 'error', message: formatError(err), timestamp: Date.now() });
    }
  }

  function setRemoteModelOverride(override: RemoteModelOverride | null): void {
    store.set(remoteModelOverrideAtom, override);
  }

  function setCloudAgentModelOverride(override: CloudAgentModelOverride | null): void {
    store.set(cloudAgentModelOverrideAtom, override);
  }

  function retryRemoteModels(): void {
    currentSession?.retryRemoteModels();
  }

  function retryRemoteCommands(): void {
    currentSession?.retryRemoteCommands();
  }

  async function createRemoteSession(input?: CreateRemoteSessionInput): Promise<KiloSessionId> {
    if (!currentSession || activeSessionType !== 'remote') {
      throw new Error(REMOTE_SESSION_CREATION_NOT_SUPPORTED);
    }
    // Inheritance from the active session (Decision 6). Explicit caller fields
    // win when provided (e.g. tests); otherwise store-derived values apply.
    const selection = store.get(remoteModelOverrideAtom)?.selection ?? store.get(observedModelAtom);
    const inherited = computeCreateRemoteSessionInheritance({
      modelSelection: selection,
      sessionMode: store.get(sessionConfigAtom)?.mode,
      lastPromptMode,
      organizationId: store.get(fetchedSessionDataAtom)?.organizationId,
    });
    const agent = input?.agent ?? inherited.agent;
    const model = input?.model ?? inherited.model;
    const orgId = input?.orgId ?? inherited.orgId;
    const merged: CreateRemoteSessionInput = {
      ...(agent !== undefined ? { agent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(orgId !== undefined ? { orgId } : {}),
    };
    const hasFields =
      merged.agent !== undefined || merged.model !== undefined || merged.orgId !== undefined;
    return currentSession.createRemoteSession(hasFields ? merged : undefined);
  }

  async function exitRemoteSession(): Promise<void> {
    if (!currentSession || activeSessionType !== 'remote') {
      throw new Error(REMOTE_SESSION_EXIT_NOT_SUPPORTED);
    }
    return currentSession.exitRemoteSession();
  }

  function destroy(): void {
    childSessionHydrationGeneration += 1;
    childSessionHydrationRequests.clear();
    switchGeneration += 1;
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
    hydrateChildSession,
    loadOlderMessages,
    send,
    setRemoteModelOverride,
    setCloudAgentModelOverride,
    retryRemoteModels,
    retryRemoteCommands,
    createRemoteSession,
    exitRemoteSession,
    interrupt,
    clearTranscript,
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
      supportsAttachments: supportsAttachmentsAtom,
      activeSessionType: activeSessionTypeAtom,
      remoteModelState: remoteModelStateAtom,
      remoteCommandState: remoteCommandStateAtom,
      observedModel: observedModelAtom,
      remoteModelOverride: remoteModelOverrideAtom,
      cloudAgentModelOverride: cloudAgentModelOverrideAtom,
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
      setupLog: setupLogAtom,
      preparationAttempts: preparationAttemptsAtom,
      sessionConfig: sessionConfigAtom,
      sessionType: sessionTypeAtom,
      chatUI: chatUIAtom,
      activeQuestion: activeQuestionAtom,
      permission: permissionAtom,
      activePermission: activePermissionAtom,
      pendingQuestions: pendingQuestionsAtom,
      pendingPermissions: pendingPermissionsAtom,
      suggestion: suggestionAtom,
      activeSuggestion: activeSuggestionAtom,
      pendingMessages: pendingMessagesAtom,
      failedPrompt: failedPromptAtom,
      fetchedSessionData: fetchedSessionDataAtom,
      availableCommands: availableCommandsAtom,
      messagesList: messagesListAtom,
      staticMessages: staticMessagesAtom,
      dynamicMessages: dynamicMessagesAtom,
      totalCost: totalCostAtom,
      contextUsage: contextUsageAtom,
      childMessages: childMessagesAtom,
      childSessionHydrationState: childSessionHydrationStateAtom,
      hasOlderMessages: hasOlderMessagesAtom,
      isLoadingOlderMessages: isLoadingOlderMessagesAtom,
      olderMessagesError: olderMessagesErrorAtom,
      olderMessagesOmittedItemCount: olderMessagesOmittedItemCountAtom,
      transcriptCleared: transcriptClearedAtom,
    },
  };
}

export { CLI_MODEL_ID, cliModelLabel, createSessionManager, formatError };
export type {
  ActiveSessionType,
  CloudAgentModelOverride,
  SessionManager,
  SessionManagerConfig,
  SessionManagerAtoms,
  SessionStatusIndicator,
  SessionConfig,
  StandalonePermission,
  StandaloneQuestion,
  StandaloneSuggestion,
  ChildSessionHydrationState,
  StoredMessage,
  FetchedSessionData,
  AssociatedPrData,
  PrepareInput,
};

export type { CreateRemoteSessionInput } from './transport';
