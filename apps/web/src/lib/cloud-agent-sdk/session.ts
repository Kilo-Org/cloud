/**
 * Session orchestrator — wires ChatProcessor, ServiceState, and
 * the appropriate transport into a single cohesive session lifecycle.
 *
 * `resolveSession` determines the session type and routes to Cloud Agent,
 * CLI live, or CLI historical transport.
 */
import type { QuestionInfo } from '@/types/opencode.gen';
import type { Images } from '@/lib/images-schema';
import type { NormalizedEvent } from './normalizer';
import { createChatProcessor } from './chat-processor';
import { createServiceState } from './service-state';
import type { ServiceState } from './service-state';
import { createCloudAgentTransport } from './cloud-agent-transport';
import { createCliLiveTransport } from './cli-live-transport';
import { createCliHistoricalTransport } from './cli-historical-transport';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import type {
  CloudAgentApi,
  CloudAgentStreamTicketResult,
  TransportFactory,
  TransportSink,
  Transport,
} from './transport';
import { createMemoryStorage } from './storage/memory';
import type { SessionStorage } from './storage/types';
import type {
  CloudAgentSessionId,
  KiloSessionId,
  ResolvedSession,
  SessionInfo,
  SessionSnapshot,
} from './types';

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
  onBranchChanged?: (branch: string) => void;
  onResolved?: (resolved: ResolvedSession) => void;
  onSessionCreated?: (info: SessionInfo) => void;
  onSessionUpdated?: (info: SessionInfo) => void;
  onEvent?: (event: NormalizedEvent) => void;
};

type CloudAgentSessionSendInput = {
  prompt: string;
  mode?: string;
  model?: string;
  variant?: string;
  messageId?: string;
  images?: Images;
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

type CloudAgentSessionTransport = {
  // Cloud Agent transport construction
  getTicket?: (
    sessionId: CloudAgentSessionId
  ) => CloudAgentStreamTicketResult | Promise<CloudAgentStreamTicketResult>;
  api?: CloudAgentApi;

  // Shared
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  lifecycleHooks?: ConnectionLifecycleHooks;
  websocketHeaders?: WebSocketHeaders;

  // CLI live transport construction
  getAuthToken?: () => string | Promise<string>;
  cliWebsocketUrl?: string;
};

type CloudAgentSession = {
  storage: SessionStorage;
  state: ServiceState;

  // Commands
  send: (payload: CloudAgentSessionSendInput) => unknown | Promise<unknown>;
  interrupt: () => unknown | Promise<unknown>;
  answer: (payload: CloudAgentSessionAnswerInput) => unknown | Promise<unknown>;
  reject: (payload: CloudAgentSessionRejectInput) => unknown | Promise<unknown>;
  respondToPermission: (
    payload: CloudAgentSessionRespondToPermissionInput
  ) => unknown | Promise<unknown>;

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
    onBranchChanged: config.onBranchChanged,
    onSessionCreated: config.onSessionCreated,
    onSessionUpdated: config.onSessionUpdated,
  });

  let transport: Transport | null = null;
  let connectGeneration = 0;

  const sink: TransportSink = {
    onChatEvent(event) {
      chatProcessor.process(event);
      config.onEvent?.(event);
    },
    onServiceEvent(event) {
      serviceState.process(event);
      config.onEvent?.(event);
    },
  };

  function pickTransportFactory(resolved: ResolvedSession): TransportFactory {
    switch (resolved.type) {
      case 'remote': {
        if (!config.transport.cliWebsocketUrl || !config.transport.getAuthToken) {
          throw new Error(
            'CloudAgentSession transport.cliWebsocketUrl and getAuthToken are required for remote CLI sessions'
          );
        }
        return createCliLiveTransport({
          kiloSessionId: resolved.kiloSessionId,
          websocketUrl: config.transport.cliWebsocketUrl,
          getAuthToken: config.transport.getAuthToken,
          fetchSnapshot: config.transport.fetchSnapshot,
          onError: config.onError,
          lifecycleHooks: config.transport.lifecycleHooks,
          websocketHeaders: config.transport.websocketHeaders,
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
  }

  return {
    storage,
    state: serviceState,
    send: payload => {
      if (!transport?.send) {
        throw new Error('CloudAgentSession transport.send is not configured');
      }
      return transport.send(payload);
    },
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
    get canSend() {
      return transport?.send !== undefined;
    },
    get canInterrupt() {
      return transport?.interrupt !== undefined;
    },
    connect() {
      if (transport) {
        transport.destroy();
        transport = null;
      }
      connectGeneration += 1;
      serviceState.setActivity({ type: 'connecting' });
      void resolveAndConnect(connectGeneration);
    },
    disconnect() {
      connectGeneration += 1;
      if (transport) {
        transport.disconnect();
        transport = null;
      }
    },
    destroy() {
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

export { createCloudAgentSession };
export type {
  CloudAgentSession,
  CloudAgentSessionAnswerInput,
  CloudAgentSessionConfig,
  CloudAgentSessionRejectInput,
  CloudAgentSessionRespondToPermissionInput,
  CloudAgentSessionSendInput,
  CloudAgentSessionTransport,
  PermissionResponse,
};
