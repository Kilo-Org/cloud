/**
 * Session orchestrator — wires ChatProcessor, ServiceState, and
 * the appropriate transport into a single cohesive session lifecycle.
 *
 * `resolveSession` determines the session type and routes to Cloud Agent,
 * CLI live, or CLI historical transport.
 */
import type { QuestionInfo } from '@/types/opencode.gen';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';
import type { Images } from '@/lib/images-schema';
import type { NormalizedEvent } from './normalizer';
import type { SuggestionAction } from './types';
import type { RemoteModelOverride, RemoteModelState } from './remote-model-catalog';
import type { RemoteCommandState } from './remote-command-catalog';
import { createChatProcessor } from './chat-processor';
import { heartbeatDataSchema, sessionsListDataSchema } from './schemas';
import { createServiceState } from './service-state';
import type { ServiceState } from './service-state';
import { createCloudAgentTransport } from './cloud-agent-transport';
import { createCliLiveTransport } from './cli-live-transport';
import { createCliHistoricalTransport } from './cli-historical-transport';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import type { UserWebConnection } from './user-web-connection';
import type {
  CloudAgentApi,
  CloudAgentStreamTicketResult,
  RemoteAttachmentPart,
  TransportFactory,
  TransportSink,
  TransportSendPayload,
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
const REMOTE_CLI_EXIT_NOT_SUPPORTED = 'Remote CLI exit is not supported for the current session';

type CloudAgentSessionConfig = {
  kiloSessionId: KiloSessionId;
  resolveSession: (kiloSessionId: KiloSessionId) => Promise<ResolvedSession>;
  transport: CloudAgentSessionTransport;
  websocketBaseUrl?: string;
  storage?: SessionStorage;
  onError?: (message: string) => void;
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
  onTransportCapabilitiesChange?: (capabilities: { attachments?: boolean } | undefined) => void;
  onSessionCreated?: (info: SessionInfo) => void;
  onSessionUpdated?: (info: SessionInfo) => void;
  onReplayComplete?: () => void;
  onEvent?: (event: NormalizedEvent) => void;
  onMessageQueued?: (messageId: string) => void;
  onMessageCompleted?: (messageId: string) => void;
  onMessageFailed?: (
    messageId: string,
    state: Extract<MessageDeliveryState, { status: 'failed' }>
  ) => void;
};

type CloudAgentSessionSendInput = {
  payload: TransportSendPayload;
  messageId?: string;
  attachments?: CloudAgentAttachments;
  images?: Images;
  remoteModelOverride?: RemoteModelOverride;
  /**
   * Ready file parts to forward to a CAPABLE remote CLI session. The
   * session-manager gate already enforces that this is only non-empty for
   * a `remote` session whose CLI has advertised `capabilities.attachments:
   * true`; transports that don't support the path (cloud-agent, read-only,
   * non-capable remote) simply ignore it.
   */
  attachmentParts?: RemoteAttachmentPart[];
};

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
  // Cloud Agent transport construction
  getTicket?: (
    sessionId: CloudAgentSessionId
  ) => CloudAgentStreamTicketResult | Promise<CloudAgentStreamTicketResult>;
  api?: CloudAgentApi;

  // Shared
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  /**
   * Page-aware root snapshot fetch. The transport uses this for its initial
   * bounded read and any reconnect snapshot replays. After a successful
   * initial fetch the transport calls `onInitialPageLoaded` so the manager
   * can record the cursor and `omittedItemCount`; reconnect replays do NOT
   * fire that callback so the user's already-advanced older-messages cursor
   * isn't reset to the latest 50 on every reconnect.
   */
  fetchSnapshotPage?: (
    kiloSessionId: KiloSessionId,
    options: { cursor?: string }
  ) => Promise<SessionSnapshotPageOutcome | null>;
  /** Called by the transport after a successful initial bounded page read. */
  onInitialPageLoaded?: (page: SessionSnapshotPage) => void;
  lifecycleHooks?: ConnectionLifecycleHooks;
  websocketHeaders?: WebSocketHeaders;

  // Remote CLI live transport construction
  userWebConnection?: UserWebConnection;
};

type CloudAgentSession = {
  storage: SessionStorage;
  state: ServiceState;

  // Commands
  send: (input: CloudAgentSessionSendInput) => unknown | Promise<unknown>;
  interrupt: () => unknown | Promise<unknown>;
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
  createRemoteSession: () => Promise<KiloSessionId>;
  exitRemoteCli: () => Promise<void>;

  // Capability checks
  canSend: boolean;
  canInterrupt: boolean;

  // Lifecycle
  connect: () => void;
  disconnect: () => void;
  destroy: () => void;
};

function createCloudAgentSession(config: CloudAgentSessionConfig): CloudAgentSession {
  const storage = config.storage ?? createMemoryStorage();

  const chatProcessor = createChatProcessor(storage);

  const serviceState = createServiceState({
    rootSessionId: config.kiloSessionId,
    onError: config.onError,
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
    onMessageCompleted: config.onMessageCompleted,
    onMessageFailed: config.onMessageFailed,
  });

  let transport: Transport | null = null;
  let connectGeneration = 0;
  let disarmUpgradeWatcher: (() => void) | null = null;

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
      if (!parsed.data.sessions.some(session => session.id === config.kiloSessionId)) return;
      connectInternal();
    });
    disarmUpgradeWatcher = () => {
      off();
      release();
    };
  }

  function connectInternal(): void {
    disarmUpgradeWatcher?.();
    disarmUpgradeWatcher = null;
    if (transport) {
      transport.destroy();
      transport = null;
    }
    connectGeneration += 1;
    serviceState.setActivity({ type: 'connecting' });
    void resolveAndConnect(connectGeneration);
  }

  const sink: TransportSink = {
    onChatEvent(event) {
      chatProcessor.process(event);
      config.onEvent?.(event);
    },
    onServiceEvent(event) {
      serviceState.process(event);
      // `cloud.message.queued` also drives chat storage — materializes a
      // synthetic user message when none exists so the UI renders the
      // prompt as soon as the server acknowledges it.
      if (event.type === 'cloud.message.queued') {
        chatProcessor.synthesizeQueuedUserMessage({
          messageId: event.messageId,
          sessionId: config.kiloSessionId,
          content: event.content,
        });
      }
      config.onEvent?.(event);
    },
    onReplayComplete: () => config.onReplayComplete?.(),
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
          fetchSnapshotPage: config.transport.fetchSnapshotPage,
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
        if (!config.transport.fetchSnapshot) {
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
          fetchSnapshotPage: config.transport.fetchSnapshotPage,
          onInitialPageLoaded: config.transport.onInitialPageLoaded,
          websocketBaseUrl: config.websocketBaseUrl,
          onError: config.onError,
          lifecycleHooks: config.transport.lifecycleHooks,
          websocketHeaders: config.transport.websocketHeaders,
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
          fetchSnapshotPage: config.transport.fetchSnapshotPage,
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

  async function resolveAndConnect(expectedGeneration: number): Promise<void> {
    let resolved: ResolvedSession;

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
    answer: payload => {
      if (!transport?.answer) {
        throw new Error('CloudAgentSession transport.answer is not configured');
      }
      return transport.answer(payload);
    },
    reject: payload => {
      if (!transport?.reject) {
        throw new Error('CloudAgentSession transport.reject is not configured');
      }
      return transport.reject(payload);
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
    createRemoteSession: async () => {
      if (!transport?.createSession) {
        throw new Error(REMOTE_SESSION_CREATION_NOT_SUPPORTED);
      }
      return transport.createSession();
    },
    exitRemoteCli: async () => {
      if (!transport?.exitCli) {
        throw new Error(REMOTE_CLI_EXIT_NOT_SUPPORTED);
      }
      return transport.exitCli();
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
      disarmUpgradeWatcher?.();
      disarmUpgradeWatcher = null;
      connectGeneration += 1;
      if (transport) {
        transport.disconnect();
        transport = null;
      }
    },
    destroy() {
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
  REMOTE_CLI_EXIT_NOT_SUPPORTED,
  REMOTE_SESSION_CREATION_NOT_SUPPORTED,
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
