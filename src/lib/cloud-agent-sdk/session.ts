/**
 * Session orchestrator — wires ChatProcessor, ServiceState, and
 * the appropriate transport into a single cohesive session lifecycle.
 *
 * `resolveSession` determines the session type and routes to Cloud Agent,
 * CLI live, or CLI historical transport.
 */
import type { QuestionInfo } from '@/types/opencode.gen';
import type { NormalizedEvent } from './normalizer';
import { createChatProcessor } from './chat-processor';
import { createServiceState } from './service-state';
import type { ServiceState } from './service-state';
import { createCloudAgentTransport } from './cloud-agent-transport';
import { createCliLiveTransport } from './cli-live-transport';
import { createCliHistoricalTransport } from './cli-historical-transport';
import type { CloudAgentApi, TransportFactory, TransportSink, Transport } from './transport';
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
  getTicket?: (sessionId: CloudAgentSessionId) => string | Promise<string>;
  api?: CloudAgentApi;

  // Shared
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;

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
      console.log('[cli-debug] sink.onChatEvent: type=%s', event.type);
      chatProcessor.process(event);
      config.onEvent?.(event);
    },
    onServiceEvent(event) {
      console.log('[cli-debug] sink.onServiceEvent: type=%s', event.type);
      serviceState.process(event);
      config.onEvent?.(event);
    },
  };

  function pickTransportFactory(resolved: ResolvedSession): TransportFactory {
    console.log('[cli-debug] pickTransportFactory: resolved=%o', resolved);
    switch (resolved.type) {
      case 'remote': {
        if (!config.transport.cliWebsocketUrl || !config.transport.getAuthToken) {
          throw new Error(
            'CloudAgentSession transport.cliWebsocketUrl and getAuthToken are required for remote CLI sessions'
          );
        }
        console.log(
          '[cli-debug] pickTransportFactory: → CLI Live transport (kiloSessionId=%s, wsUrl=%s)',
          resolved.kiloSessionId,
          config.transport.cliWebsocketUrl
        );
        return createCliLiveTransport({
          kiloSessionId: resolved.kiloSessionId,
          websocketUrl: config.transport.cliWebsocketUrl,
          getAuthToken: config.transport.getAuthToken,
          fetchSnapshot: config.transport.fetchSnapshot,
          onError: config.onError,
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
        console.log(
          '[cli-debug] pickTransportFactory: → Cloud Agent transport (cloudAgentSessionId=%s)',
          resolved.cloudAgentSessionId
        );
        return createCloudAgentTransport({
          sessionId: resolved.cloudAgentSessionId,
          kiloSessionId: config.kiloSessionId,
          api: config.transport.api,
          getTicket: config.transport.getTicket,
          fetchSnapshot: config.transport.fetchSnapshot,
          websocketBaseUrl: config.websocketBaseUrl,
          onError: config.onError,
        });
      }
      case 'read-only': {
        if (!config.transport.fetchSnapshot) {
          throw new Error(
            'CloudAgentSession transport.fetchSnapshot is required for read-only sessions'
          );
        }
        console.log(
          '[cli-debug] pickTransportFactory: → Historical transport (kiloSessionId=%s)',
          resolved.kiloSessionId
        );
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
    console.log('[cli-debug] resolveAndConnect: kiloSessionId=%s', config.kiloSessionId);
    let resolved: ResolvedSession;

    try {
      resolved = await config.resolveSession(config.kiloSessionId);
    } catch (error) {
      if (expectedGeneration !== connectGeneration) return;
      const message = error instanceof Error ? error.message : 'Failed to resolve session';
      console.log('[cli-debug] resolveAndConnect: error=%s', message);
      config.onError?.(message);
      serviceState.setActivity({ type: 'idle' });
      serviceState.setStatus({ type: 'error', message });
      return;
    }

    if (expectedGeneration !== connectGeneration) return;

    console.log('[cli-debug] resolveAndConnect: resolved=%o', resolved);
    config.onResolved?.(resolved);

    let factory: TransportFactory;
    try {
      factory = pickTransportFactory(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create transport';
      console.log('[cli-debug] resolveAndConnect: error=%s', message);
      config.onError?.(message);
      serviceState.setActivity({ type: 'idle' });
      serviceState.setStatus({ type: 'error', message });
      return;
    }

    transport = factory(sink);
    console.log('[cli-debug] resolveAndConnect: transport created, calling connect()');
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
      console.log(
        '[cli-debug] CloudAgentSession.connect() called, kiloSessionId=%s',
        config.kiloSessionId
      );
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
