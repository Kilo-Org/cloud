/**
 * Session orchestrator — wires ChatProcessor, ServiceState, and
 * the appropriate transport into a single cohesive session lifecycle.
 *
 * `resolveSession` determines the session type and routes to Cloud Agent,
 * CLI live, or CLI historical transport.
 */
import type { ToolDisplayMode } from './tool-detail-marker';
import type { QuestionInfo } from '@kilocode/app-shared/opencode';
import type { NormalizedEvent, ServiceEvent } from './normalizer';
import type { SuggestionAction } from './types';
import type { RemoteModelState } from './remote-model-catalog';
import type { RemoteCommandState } from './remote-command-catalog';
import { createChatProcessor } from './chat-processor';
import { heartbeatDataSchema, sessionsListDataSchema } from './schemas';
import { createServiceState } from './service-state';
import type { ServiceState } from './service-state';
import { createCloudAgentTransport, type CloudAgentTransportConfig } from './cloud-agent-transport';
import { createCliLiveTransport } from './cli-live-transport';
import { createCliHistoricalTransport } from './cli-historical-transport';
import type { SessionSnapshotFailure } from './snapshot-page';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import type { UserWebConnection } from './user-web-connection';
import type {
  CloudAgentApi,
  CloudAgentStreamTicketResult,
  CreateRemoteSessionInput,
  TransportFactory,
  TransportSink,
  TransportSendInput,
  Transport,
} from './transport';
import { createMemoryStorage } from './storage/memory';
import type { SessionStorage } from './storage/types';
import type {
  CloudAgentSessionId,
  KiloSessionId,
  MessageDeliveryState,
  ResolvedSession,
  SessionInfo,
  SessionSnapshot,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
} from './types';

const REMOTE_SESSION_CREATION_NOT_SUPPORTED =
  'Remote session creation is not supported for the current session';
const REMOTE_SESSION_EXIT_NOT_SUPPORTED =
  'Remote session exit is not supported for the current session';
/**
 * A create needs the active session's own scope. The manager reports this while
 * that scope is not available yet. The message reaches a client's toast
 * verbatim, so it names the reader's situation and their next step.
 */
const REMOTE_SESSION_CREATION_SCOPE_UNRESOLVED =
  'This session is still loading. Try again in a moment.';
/**
 * A create must stay in the active session's organization. The message reaches
 * a client's toast verbatim, so it names the reader's situation and next step.
 */
const REMOTE_SESSION_ORGANIZATION_MISMATCH =
  "A new session stays in this session's organization. Switch organization first.";

/**
 * Initial cool-down before the read-only upgrade watcher re-arms after a
 * re-resolve that stayed read-only (or failed). Subscribing makes the server
 * re-send sessions.list for the watched session; without this window that
 * re-send would immediately re-fire the watcher that just armed.
 */
const READ_ONLY_REARM_COOLDOWN_MS = 1_000;
/**
 * Cap for the escalating re-arm backoff. Inconclusive attempts retry at 1s,
 * 2s, 4s ... up to this ceiling, so a transient presence outage still closes
 * the eventual-consistency window without an unbounded resolve loop.
 */
const READ_ONLY_REARM_MAX_BACKOFF_MS = 30_000;

type CloudAgentSessionConfig = {
  kiloSessionId: KiloSessionId;
  resolveSession: (kiloSessionId: KiloSessionId) => Promise<ResolvedSession>;
  transport: CloudAgentSessionTransport;
  websocketBaseUrl?: string;
  storage?: SessionStorage;
  onError?: (message: string, failure?: SessionSnapshotFailure) => void;
  onChildSessionError?: (sessionId: string, message: string) => void;
  onQuestionAsked?: (requestId: string, questions?: QuestionInfo[]) => void;
  onQuestionResolved?: (requestId: string) => void;
  onPermissionAsked?: (
    requestId: string,
    permission?: string,
    patterns?: string[],
    metadata?: Record<string, unknown>,
    always?: string[]
  ) => void;
  onPermissionResolved?: (requestId: string) => void;
  onSuggestionAsked?: (
    requestId: string,
    text: string,
    actions: SuggestionAction[],
    callId?: string
  ) => void;
  onSuggestionResolved?: (requestId: string) => void;
  onBranchChanged?: (branch: string) => void;
  onResolved?: (resolved: ResolvedSession) => void;
  onRemoteModelStateChange?: (state: RemoteModelState) => void;
  onRemoteCommandStateChange?: (state: RemoteCommandState) => void;
  onTransportCapabilityChange?: () => void;
  onTransportCapabilitiesChange?:
    | ((capabilities: { attachments?: boolean | undefined } | undefined) => void)
    | undefined;
  onSessionCreated?: (info: SessionInfo) => void;
  onSessionUpdated?: (info: SessionInfo) => void;
  onReplayComplete?: () => void;
  onEvent?: (event: NormalizedEvent) => void;
  onMessageQueued?: (messageId: string) => void;
  onMessageCanceled?: (messageId: string) => void;
  onMessageCompleted?: (messageId: string) => void;
  onMessageFailed?: (
    messageId: string,
    state: Extract<MessageDeliveryState, { status: 'failed' }>
  ) => void;
  /**
   * True when the user already retried this message's delivery failure, so a
   * replayed `cloud.message.failed` must not restore the cleared footer.
   */
  isDeliveryFailureResolved?: (messageId: string) => boolean;
  /**
   * Optional sink for tool attachment bytes, called just before the chat
   * processor strips a completed tool part's attachment data URLs for storage.
   * Receives the raw data URL exactly once per processor pass; consumers use
   * it to persist bytes outside the in-memory store (e.g. mobile's
   * file-system cache). Web never passes it, so web behaviour is unchanged.
   */
  onToolAttachment?:
    | ((partId: string, attachment: { mime: string; filename?: string; dataUrl: string }) => void)
    | undefined;
  /**
   * Optional sink for top-level file part URLs, called just before the chat
   * processor strips a file part's `url` and `source.text` for storage.
   * Receives the raw URL exactly once per processor pass; consumers use it to
   * preview the file later (e.g. mobile). Web never passes it.
   */
  onFilePart?:
    | ((partId: string, file: { mime: string; filename?: string; url: string }) => void)
    | undefined;
};

/** The session sends straight through, so its input is the transport contract. */
type CloudAgentSessionSendInput = TransportSendInput;

type CloudAgentSessionAnswerInput = {
  requestId: string;
  answers: string[][];
};

type CloudAgentSessionRejectInput = {
  requestId: string;
};

type PermissionResponse = 'once' | 'always' | 'reject';

type CloudAgentSessionRespondToPermissionInput = {
  requestId: string;
  response: PermissionResponse;
};

type CloudAgentSessionAcceptSuggestionInput = {
  requestId: string;
  index: number;
};

type CloudAgentSessionDismissSuggestionInput = {
  requestId: string;
};

type CloudAgentSessionTransport = {
  getTicket?:
    | ((
        sessionId: CloudAgentSessionId
      ) => CloudAgentStreamTicketResult | Promise<CloudAgentStreamTicketResult>)
    | undefined;
  api?: CloudAgentApi | undefined;

  fetchSnapshot?: ((kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>) | undefined;
  /**
   * Page-aware root snapshot fetch. The transport uses this for its initial
   * bounded read and any reconnect snapshot replays. Once per attach, with the
   * first page that applies, the transport calls `onInitialPageLoaded` so the
   * manager can record the cursor and `omittedItemCount`; later replays do NOT
   * fire that callback so the user's already-advanced older-messages cursor
   * isn't reset to the latest 50.
   */
  fetchSnapshotPage?:
    | ((
        kiloSessionId: KiloSessionId,
        options: { cursor?: string }
      ) => Promise<SessionSnapshotPageOutcome | null>)
    | undefined;
  fetchCloudSnapshotPage?:
    | ((
        sessionId: CloudAgentSessionId,
        options: { cursor?: string; limit?: number; kiloSessionId?: string }
      ) => Promise<unknown>)
    | undefined;
  initialSnapshotRead?: CloudAgentTransportConfig['initialSnapshotRead'];
  /**
   * Called by the transport once per attach, with the first page that applies
   * after the initial read starts.
   */
  onInitialPageLoaded?: ((page: SessionSnapshotPage) => void) | undefined;
  lifecycleHooks?: ConnectionLifecycleHooks | undefined;
  websocketHeaders?: WebSocketHeaders | undefined;
  /** Requests bounded completed-tool previews in historical stream replay. */
  toolDisplay?: ToolDisplayMode | undefined;

  userWebConnection?: UserWebConnection | undefined;
};

type CloudAgentSession = {
  storage: SessionStorage;
  state: ServiceState;

  send: (input: CloudAgentSessionSendInput) => unknown | Promise<unknown>;
  interrupt: () => unknown | Promise<unknown>;
  cancelQueuedMessage: (messageId: string) => Promise<{ dropped: boolean }>;
  answer: (payload: CloudAgentSessionAnswerInput) => unknown | Promise<unknown>;
  reject: (payload: CloudAgentSessionRejectInput) => unknown | Promise<unknown>;
  respondToPermission: (
    payload: CloudAgentSessionRespondToPermissionInput
  ) => unknown | Promise<unknown>;
  acceptSuggestion: (payload: CloudAgentSessionAcceptSuggestionInput) => unknown | Promise<unknown>;
  dismissSuggestion: (
    payload: CloudAgentSessionDismissSuggestionInput
  ) => unknown | Promise<unknown>;
  retryRemoteModels: () => void;
  retryRemoteCommands: () => void;
  retryBackgroundActivity?: () => void;
  observeProjected: (messages: SessionSnapshot['messages']) => void;
  createRemoteSession: (input?: CreateRemoteSessionInput) => Promise<KiloSessionId>;
  exitRemoteSession: () => Promise<void>;

  canSend: boolean;
  canInterrupt: boolean;

  connect: () => void;
  disconnect: () => void;
  destroy: () => void;
};

function createCloudAgentSession(config: CloudAgentSessionConfig): CloudAgentSession {
  const storage = config.storage ?? createMemoryStorage();

  const chatProcessor = createChatProcessor(storage, {
    onToolAttachment: config.onToolAttachment,
    onFilePart: config.onFilePart,
  });

  const serviceState = createServiceState({
    rootSessionId: config.kiloSessionId,
    onError: config.onError,
    onChildSessionError: config.onChildSessionError,
    onQuestionAsked: config.onQuestionAsked,
    onQuestionResolved: config.onQuestionResolved,
    onPermissionAsked: config.onPermissionAsked,
    onPermissionResolved: config.onPermissionResolved,
    onSuggestionAsked: config.onSuggestionAsked,
    onSuggestionResolved: config.onSuggestionResolved,
    onBranchChanged: config.onBranchChanged,
    onSessionCreated: config.onSessionCreated,
    onSessionUpdated: config.onSessionUpdated,
    onMessageQueued: config.onMessageQueued,
    onMessageCanceled: config.onMessageCanceled,
    onMessageCompleted: config.onMessageCompleted,
    onMessageFailed: config.onMessageFailed,
    isDeliveryFailureResolved: config.isDeliveryFailureResolved,
  });

  let transport: Transport | null = null;
  let replaying = false;
  const replayedQueuedMessages = new Map<
    string,
    Extract<ServiceEvent, { type: 'cloud.message.queued' }>
  >();
  let connectGeneration = 0;
  let disarmUpgradeWatcher: (() => void) | null = null;
  // Last CLI row the watcher accepted as new evidence for the current
  // read-only open. A payload whose watched row carries the same status and
  // connection as this one brings nothing new, so it must not re-resolve.
  let lastUpgradeEvidence: { status: string; connectionId?: string | undefined } | null = null;
  // The row that produced the most recent inconclusive (stay-read-only or
  // failed) attempt. The backoff resets only when accepted evidence differs
  // from this row — a repeat of the same row after a re-arm is a retry of the
  // same attempt, not new evidence, and keeps the escalated interval.
  let lastAttemptRow: { status: string; connectionId?: string | undefined } | null = null;
  let rearmTimer: ReturnType<typeof setTimeout> | null = null;
  // Current backoff delay for inconclusive (stay-read-only or failed) upgrade
  // attempts. Resets whenever the watcher sees genuinely new evidence.
  let rearmBackoffMs = READ_ONLY_REARM_COOLDOWN_MS;

  // A session resolves to 'read-only' when the CLI hasn't (yet) reported it as
  // active — but that signal is eventually consistent: enabling remote on the
  // CLI takes a connect + heartbeat round-trip to register. Without this
  // watcher, opening the session inside that window pins it to the static
  // historical snapshot forever. Watch the user-web connection for the session
  // showing up in a CLI heartbeat/list and re-resolve to upgrade to live.
  function armUpgradeWatcher(): void {
    const connection = config.transport.userWebConnection;
    if (!connection) return;

    // Subscribe (not just retain) while watching: the server only pushes
    // sessions.heartbeat and subscribe-triggered sessions.list re-sends to
    // sockets subscribed to the session, so a bare retain never sees the
    // upgrade trigger. Subscribing also retains the socket.
    const release = connection.subscribeToCliSession(config.kiloSessionId);
    const off = connection.onSystemEvent(({ event, data }) => {
      if (event !== 'sessions.list' && event !== 'sessions.heartbeat') return;
      const schema = event === 'sessions.list' ? sessionsListDataSchema : heartbeatDataSchema;
      const parsed = schema.safeParse(data);
      if (!parsed.success) return;
      const row = parsed.data.sessions.find(session => session.id === config.kiloSessionId);
      if (!row) return;
      // Subscribe-triggered sessions.list re-sends repeat the same row we
      // already acted on. Only a status or connection change is new evidence;
      // acting on every payload would drive a teardown/refetch loop.
      const evidence = {
        status: row.status,
        connectionId: typeof row['connectionId'] === 'string' ? row['connectionId'] : undefined,
      };
      const unchanged =
        lastUpgradeEvidence !== null &&
        lastUpgradeEvidence.status === evidence.status &&
        lastUpgradeEvidence.connectionId === evidence.connectionId;
      if (unchanged) return;
      lastUpgradeEvidence = evidence;
      const rowChanged =
        lastAttemptRow === null ||
        lastAttemptRow.status !== evidence.status ||
        lastAttemptRow.connectionId !== evidence.connectionId;
      if (rowChanged) rearmBackoffMs = READ_ONLY_REARM_COOLDOWN_MS;
      void handleUpgradeTrigger();
    });
    disarmUpgradeWatcher = () => {
      off();
      release();
    };
  }

  function clearRearmTimer(): void {
    if (rearmTimer !== null) {
      clearTimeout(rearmTimer);
      rearmTimer = null;
    }
  }

  /**
   * Re-resolve without destroying the live read-only transport first: the
   * transport keeps serving the historical snapshot until the resolution
   * actually changes type, so a stay-read-only result costs one resolve call
   * and nothing else. A 1s cool-down before re-arming keeps the
   * subscribe-triggered sessions.list re-send from immediately re-firing the
   * watcher that just armed.
   */
  async function handleUpgradeTrigger(): Promise<void> {
    clearRearmTimer();
    disarmUpgradeWatcher?.();
    disarmUpgradeWatcher = null;
    connectGeneration += 1;
    const expectedGeneration = connectGeneration;
    lastAttemptRow = lastUpgradeEvidence;

    let resolved: ResolvedSession;
    try {
      resolved = await config.resolveSession(config.kiloSessionId);
    } catch (error) {
      if (expectedGeneration !== connectGeneration) return;
      const message = error instanceof Error ? error.message : 'Failed to resolve session';
      config.onError?.(message);
      serviceState.setActivity({ type: 'idle' });
      serviceState.setStatus({ type: 'error', message });
      scheduleUpgradeRetry();
      return;
    }

    if (expectedGeneration !== connectGeneration) return;

    if (resolved.type !== 'read-only') {
      // Real upgrade: destroy the historical transport and rebuild on the new
      // resolution. resolveAndConnect reports the resolution (onResolved), so
      // it fires exactly once per resolved session in every path.
      lastAttemptRow = null;
      if (transport) {
        transport.destroy();
        transport = null;
      }
      serviceState.setActivity({ type: 'connecting' });
      await resolveAndConnect(expectedGeneration, resolved);
      return;
    }

    // Still read-only: keep the current transport (snapshot and history stay
    // intact) and re-arm on a backoff so a heartbeat stream or a presence
    // outage cannot drive a reconnect loop. The backoff also clears the
    // evidence at re-arm time, so an idle CLI's identical rows retry the
    // resolve once per interval — the eventual-consistency window still
    // closes after a transient outage.
    config.onResolved?.(resolved);
    scheduleUpgradeRetry();
  }

  /**
   * Re-arm the upgrade watcher after a backoff that doubles with each
   * inconclusive attempt and clears the last observed row, so the next
   * payload — even a verbatim repeat — retries the resolve. New evidence
   * resets the backoff.
   */
  function scheduleUpgradeRetry(): void {
    clearRearmTimer();
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      lastUpgradeEvidence = null;
      armUpgradeWatcher();
    }, rearmBackoffMs);
    rearmBackoffMs = Math.min(rearmBackoffMs * 2, READ_ONLY_REARM_MAX_BACKOFF_MS);
  }

  function connectInternal(): void {
    clearRearmTimer();
    disarmUpgradeWatcher?.();
    disarmUpgradeWatcher = null;
    lastUpgradeEvidence = null;
    lastAttemptRow = null;
    rearmBackoffMs = READ_ONLY_REARM_COOLDOWN_MS;
    if (transport) {
      transport.destroy();
      transport = null;
    }
    connectGeneration += 1;
    serviceState.setActivity({ type: 'connecting' });
    void resolveAndConnect(connectGeneration);
  }

  function emitEventToListener(event: NormalizedEvent): void {
    try {
      config.onEvent?.(event);
    } catch (error) {
      console.error(`[Session] Event listener threw on ${event.type}:`, error);
    }
  }

  const sink: TransportSink = {
    onChatEvent(event) {
      // Keep one event's failure from taking the events after it: report and
      // carry on rather than surfacing a session error for a single chat
      // event, so the transcript keeps streaming.
      try {
        if (!chatProcessor.process(event)) return;
      } catch (error) {
        console.error(`[Session] Failed to process ${event.type}:`, error);
      }
      emitEventToListener(event);
    },
    onServiceEvent(event) {
      serviceState.process(event);
      // `cloud.message.queued` also drives chat storage — materializes a
      // synthetic user message when none exists so the UI renders the
      // prompt as soon as the server acknowledges it.
      if (event.type === 'cloud.message.queued') {
        if (replaying) replayedQueuedMessages.set(event.messageId, event);
        else {
          chatProcessor.synthesizeQueuedUserMessage({
            messageId: event.messageId,
            sessionId: config.kiloSessionId,
            content: event.content,
            createdAt: event.createdAt,
          });
        }
      }
      if (event.type === 'cloud.message.sent' && event.turnType === 'command') {
        replayedQueuedMessages.delete(event.messageId);
        const message = storage.getMessageInfo(event.messageId);
        if (message?.role === 'user' && message.synthetic === true) {
          storage.deleteMessage(event.messageId);
        }
      }
      // `cloud.message.canceled` removes the synthetic (or real) local row the
      // queued event materialized, so a replay of queued then canceled nets empty.
      if (event.type === 'cloud.message.canceled') {
        replayedQueuedMessages.delete(event.messageId);
        storage.deleteMessage(event.messageId);
      }
      if (event.type === 'cloud.message.completed') replayedQueuedMessages.delete(event.messageId);
      emitEventToListener(event);
    },
    onReplayStarted: () => {
      replaying = true;
      replayedQueuedMessages.clear();
      serviceState.beginReplay();
    },
    onReplayCanceled: () => {
      replaying = false;
      replayedQueuedMessages.clear();
      serviceState.cancelReplay();
    },
    onReplayComplete: () => {
      for (const event of replayedQueuedMessages.values()) {
        if (
          !serviceState.getPendingMessages().has(event.messageId) &&
          serviceState.getActiveMessageId() !== event.messageId
        )
          continue;
        chatProcessor.synthesizeQueuedUserMessage({
          messageId: event.messageId,
          sessionId: config.kiloSessionId,
          content: event.content,
          createdAt: event.createdAt,
        });
      }
      replayedQueuedMessages.clear();
      replaying = false;
      serviceState.endReplay();
      config.onReplayComplete?.();
    },
  };

  function pickTransportFactory(resolved: ResolvedSession): TransportFactory {
    switch (resolved.type) {
      case 'remote': {
        if (!config.transport.userWebConnection) {
          throw new Error(
            'CloudAgentSession transport.userWebConnection is required for remote CLI sessions'
          );
        }
        return createCliLiveTransport({
          kiloSessionId: resolved.kiloSessionId,
          userWebConnection: config.transport.userWebConnection,
          fetchSnapshot: config.transport.fetchSnapshot,
          ...(config.transport.fetchSnapshotPage
            ? { fetchSnapshotPage: config.transport.fetchSnapshotPage }
            : {}),
          onInitialPageLoaded: config.transport.onInitialPageLoaded,
          onError: config.onError,
          onRemoteModelStateChange: config.onRemoteModelStateChange,
          onRemoteCommandStateChange: config.onRemoteCommandStateChange,
          onCapabilityChange: config.onTransportCapabilityChange,
          onCapabilitiesChange: config.onTransportCapabilitiesChange,
        });
      }
      case 'cloud-agent': {
        if (!config.transport.getTicket) {
          throw new Error(
            'CloudAgentSession transport.getTicket is required for Cloud Agent sessions'
          );
        }
        if (
          !config.transport.fetchSnapshot &&
          !resolved.cloudAgentSessionId.startsWith('workspace_')
        ) {
          throw new Error(
            'CloudAgentSession transport.fetchSnapshot is required for Cloud Agent sessions'
          );
        }
        if (!config.transport.api) {
          throw new Error('CloudAgentSession transport.api is required for Cloud Agent sessions');
        }
        if (!config.websocketBaseUrl) {
          throw new Error(
            'CloudAgentSession websocketBaseUrl is required for Cloud Agent sessions'
          );
        }
        return createCloudAgentTransport({
          sessionId: resolved.cloudAgentSessionId,
          kiloSessionId: config.kiloSessionId,
          api: config.transport.api,
          getTicket: config.transport.getTicket,
          fetchSnapshot: config.transport.fetchSnapshot,
          fetchCloudSnapshotPage: config.transport.fetchCloudSnapshotPage,
          initialSnapshotRead: config.transport.initialSnapshotRead,
          ...(config.transport.fetchSnapshotPage
            ? { fetchSnapshotPage: config.transport.fetchSnapshotPage }
            : {}),
          onInitialPageLoaded: config.transport.onInitialPageLoaded,
          websocketBaseUrl: config.websocketBaseUrl,
          onError: config.onError,
          lifecycleHooks: config.transport.lifecycleHooks,
          websocketHeaders: config.transport.websocketHeaders,
          toolDisplay: config.transport.toolDisplay,
        });
      }
      case 'read-only': {
        if (!config.transport.fetchSnapshot) {
          throw new Error(
            'CloudAgentSession transport.fetchSnapshot is required for read-only sessions'
          );
        }
        return createCliHistoricalTransport({
          kiloSessionId: resolved.kiloSessionId,
          fetchSnapshot: config.transport.fetchSnapshot,
          ...(config.transport.fetchSnapshotPage
            ? { fetchSnapshotPage: config.transport.fetchSnapshotPage }
            : {}),
          onInitialPageLoaded: config.transport.onInitialPageLoaded,
          onError: config.onError,
        });
      }
      default: {
        const _exhaustive: never = resolved;
        throw new Error(`Unknown resolved session type: ${(_exhaustive as { type: string }).type}`);
      }
    }
  }

  async function resolveAndConnect(
    expectedGeneration: number,
    preResolved?: ResolvedSession
  ): Promise<void> {
    let resolved: ResolvedSession;

    if (preResolved) {
      resolved = preResolved;
    } else {
      try {
        resolved = await config.resolveSession(config.kiloSessionId);
      } catch (error) {
        if (expectedGeneration !== connectGeneration) return;
        const message = error instanceof Error ? error.message : 'Failed to resolve session';
        config.onError?.(message);
        serviceState.setActivity({ type: 'idle' });
        serviceState.setStatus({ type: 'error', message });
        return;
      }

      if (expectedGeneration !== connectGeneration) return;
    }

    config.onResolved?.(resolved);

    let factory: TransportFactory;
    try {
      factory = pickTransportFactory(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create transport';
      config.onError?.(message);
      serviceState.setActivity({ type: 'idle' });
      serviceState.setStatus({ type: 'error', message });
      return;
    }

    transport = factory(sink);
    transport.connect();

    if (resolved.type === 'read-only') {
      lastUpgradeEvidence = null;
      lastAttemptRow = null;
      rearmBackoffMs = READ_ONLY_REARM_COOLDOWN_MS;
      armUpgradeWatcher();
    }
  }

  const send = (input: CloudAgentSessionSendInput): unknown | Promise<unknown> => {
    if (!transport?.send) {
      throw new Error('CloudAgentSession transport.send is not configured');
    }
    return transport.send(input);
  };

  return {
    storage,
    state: serviceState,
    send,
    interrupt: () => {
      if (!transport?.interrupt) {
        throw new Error('CloudAgentSession transport.interrupt is not configured');
      }
      return transport.interrupt();
    },
    cancelQueuedMessage: messageId => {
      if (!transport?.dropQueuedMessage) {
        throw new Error('CloudAgentSession transport.dropQueuedMessage is not configured');
      }
      return transport.dropQueuedMessage(messageId);
    },
    answer: payload => {
      if (!transport?.answer) {
        throw new Error('CloudAgentSession transport.answer is not configured');
      }
      return Promise.resolve(transport.answer(payload)).then(result => {
        if (
          result &&
          typeof result === 'object' &&
          'success' in result &&
          result.success === false
        ) {
          throw new Error('Failed to submit answer. Please try again.');
        }
        serviceState.process({ type: 'question.replied', requestId: payload.requestId });
        return result;
      });
    },
    reject: payload => {
      if (!transport?.reject) {
        throw new Error('CloudAgentSession transport.reject is not configured');
      }
      return Promise.resolve(transport.reject(payload)).then(result => {
        if (
          result &&
          typeof result === 'object' &&
          'success' in result &&
          result.success === false
        ) {
          throw new Error('Failed to dismiss question. Please try again.');
        }
        serviceState.process({ type: 'question.rejected', requestId: payload.requestId });
        return result;
      });
    },
    respondToPermission: payload => {
      if (!transport?.respondToPermission) {
        throw new Error('CloudAgentSession transport.respondToPermission is not configured');
      }
      return transport.respondToPermission(payload);
    },
    acceptSuggestion: async payload => {
      if (!transport?.acceptSuggestion) {
        throw new Error('CloudAgentSession transport.acceptSuggestion is not configured');
      }
      // Wait for the command to be acknowledged before clearing local state,
      // so that transport failures (network drop, 404, timeout) can propagate
      // back to the caller and the SuggestionCard stays mounted to surface
      // the error. The bus event that follows is a no-op thanks to the
      // requestId guard in processSuggestionResolved.
      const result = await transport.acceptSuggestion(payload);
      const current = serviceState.getSuggestion();
      if (current && current.requestId === payload.requestId) {
        serviceState.process({
          type: 'suggestion.accepted',
          requestId: payload.requestId,
          index: payload.index,
        });
      }
      return result;
    },
    dismissSuggestion: async payload => {
      if (!transport?.dismissSuggestion) {
        throw new Error('CloudAgentSession transport.dismissSuggestion is not configured');
      }
      const result = await transport.dismissSuggestion(payload);
      const current = serviceState.getSuggestion();
      if (current && current.requestId === payload.requestId) {
        serviceState.process({
          type: 'suggestion.dismissed',
          requestId: payload.requestId,
        });
      }
      return result;
    },
    retryRemoteModels() {
      transport?.retryRemoteModels?.();
    },
    retryRemoteCommands() {
      transport?.retryRemoteCommands?.();
    },
    retryBackgroundActivity() {
      transport?.retryBackgroundActivity?.();
    },
    observeProjected(messages) {
      transport?.observeProjected?.(messages);
    },
    createRemoteSession: async (input?: CreateRemoteSessionInput) => {
      if (!transport?.createSession) {
        throw new Error(REMOTE_SESSION_CREATION_NOT_SUPPORTED);
      }
      return transport.createSession(input);
    },
    exitRemoteSession: async () => {
      if (!transport?.exitSession) {
        throw new Error(REMOTE_SESSION_EXIT_NOT_SUPPORTED);
      }
      return transport.exitSession();
    },
    get canSend() {
      return transport?.send !== undefined && (transport.canSend?.() ?? true);
    },
    get canInterrupt() {
      return transport?.interrupt !== undefined;
    },
    connect() {
      connectInternal();
    },
    disconnect() {
      clearRearmTimer();
      disarmUpgradeWatcher?.();
      disarmUpgradeWatcher = null;
      connectGeneration += 1;
      if (transport) {
        transport.disconnect();
        transport = null;
      }
    },
    destroy() {
      clearRearmTimer();
      disarmUpgradeWatcher?.();
      disarmUpgradeWatcher = null;
      connectGeneration += 1;
      if (transport) {
        transport.destroy();
        transport = null;
      }
      storage.clear();
      serviceState.reset();
    },
  };
}

export {
  createCloudAgentSession,
  REMOTE_SESSION_EXIT_NOT_SUPPORTED,
  REMOTE_SESSION_CREATION_NOT_SUPPORTED,
  REMOTE_SESSION_CREATION_SCOPE_UNRESOLVED,
  REMOTE_SESSION_ORGANIZATION_MISMATCH,
};
export type {
  CloudAgentSession,
  CloudAgentSessionAcceptSuggestionInput,
  CloudAgentSessionAnswerInput,
  CloudAgentSessionConfig,
  CloudAgentSessionDismissSuggestionInput,
  CloudAgentSessionRejectInput,
  CloudAgentSessionRespondToPermissionInput,
  CloudAgentSessionSendInput,
  CloudAgentSessionTransport,
  PermissionResponse,
};
