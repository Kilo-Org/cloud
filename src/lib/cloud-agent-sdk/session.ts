/**
 * Session orchestrator — wires ChatProcessor, ServiceState, and
 * the appropriate transport into a single cohesive session lifecycle.
 *
 * `resolveSession` determines the session type and routes to Cloud Agent,
 * CLI live, or CLI historical transport.
 */
import type { QuestionInfo, Session } from '@/types/opencode.gen';
import type { NormalizedEvent } from './normalizer';
import { createChatProcessor } from './chat-processor';
import { createServiceState } from './service-state';
import type { ServiceState } from './service-state';
import { createCloudAgentTransport } from './cloud-agent-transport';
import { createCliLiveTransport } from './cli-live-transport';
import { createCliHistoricalTransport } from './cli-historical-transport';
import type { TransportFactory, TransportSink, Transport } from './transport';
import { createMemoryStorage } from './storage/memory';
import type { SessionStorage } from './storage/types';
import type { CloudAgentSessionId, KiloSessionId, ResolvedSession, SessionSnapshot } from './types';

type CloudAgentSessionConfig = {
  kiloSessionId: KiloSessionId;
  resolveSession: (kiloSessionId: KiloSessionId) => Promise<ResolvedSession>;
  transport: CloudAgentSessionTransport;
  websocketBaseUrl?: string;
  storage?: SessionStorage;
  onError?: (message: string) => void;
  onQuestionAsked?: (requestId: string, callId?: string, questions?: QuestionInfo[]) => void;
  onQuestionResolved?: (requestId: string) => void;
  onPermissionAsked?: (
    requestId: string,
    callId?: string,
    permission?: string,
    patterns?: string[],
    metadata?: Record<string, unknown>,
    always?: string[]
  ) => void;
  onPermissionResolved?: (requestId: string) => void;
  onBranchChanged?: (branch: string) => void;
  onSessionCreated?: (info: Session) => void;
  onSessionUpdated?: (info: Session) => void;
  onEvent?: (event: NormalizedEvent) => void;
};

type CloudAgentSessionSendInput = Record<string, unknown>;

type CloudAgentSessionTransportInterruptInput = {
  sessionId: CloudAgentSessionId;
};

type CloudAgentSessionAnswerInput = {
  requestId: string;
  answers: string[][];
};

type CloudAgentSessionTransportAnswerInput = CloudAgentSessionAnswerInput & {
  sessionId: CloudAgentSessionId;
};

type CloudAgentSessionRejectInput = {
  requestId: string;
};

type CloudAgentSessionTransportRejectInput = CloudAgentSessionRejectInput & {
  sessionId: CloudAgentSessionId;
};

type PermissionResponse = 'once' | 'always' | 'reject';

type CloudAgentSessionRespondToPermissionInput = {
  requestId: string;
  response: PermissionResponse;
};

type CloudAgentSessionTransportRespondToPermissionInput =
  CloudAgentSessionRespondToPermissionInput & {
    sessionId: CloudAgentSessionId;
  };

type CloudAgentSessionTransport = {
  // For Cloud Agent sessions
  getTicket?: (sessionId: CloudAgentSessionId) => string | Promise<string>;
  send?: (
    payload: CloudAgentSessionSendInput & { sessionId: CloudAgentSessionId }
  ) => unknown | Promise<unknown>;
  interrupt?: (payload: CloudAgentSessionTransportInterruptInput) => unknown | Promise<unknown>;
  answer?: (payload: CloudAgentSessionTransportAnswerInput) => unknown | Promise<unknown>;
  reject?: (payload: CloudAgentSessionTransportRejectInput) => unknown | Promise<unknown>;
  respondToPermission?: (
    payload: CloudAgentSessionTransportRespondToPermissionInput
  ) => unknown | Promise<unknown>;

  // For CLI sessions
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
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
  let resolvedCloudAgentSessionId: CloudAgentSessionId | null = null;
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
    if (resolved.cloudAgentSessionId) {
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
      console.log(
        '[cli-debug] pickTransportFactory: → Cloud Agent transport (cloudAgentSessionId=%s)',
        resolved.cloudAgentSessionId
      );
      return createCloudAgentTransport({
        sessionId: resolved.cloudAgentSessionId,
        kiloSessionId: config.kiloSessionId,
        getTicket: config.transport.getTicket,
        fetchSnapshot: config.transport.fetchSnapshot,
        websocketBaseUrl: config.websocketBaseUrl,
        onError: config.onError,
      });
    }

    if (resolved.isLive) {
      if (!config.transport.cliWebsocketUrl || !config.transport.getAuthToken) {
        throw new Error(
          'CloudAgentSession transport.cliWebsocketUrl and getAuthToken are required for live CLI sessions'
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

    if (!config.transport.fetchSnapshot) {
      throw new Error(
        'CloudAgentSession transport.fetchSnapshot is required for historical CLI sessions'
      );
    }
    console.log(
      '[cli-debug] pickTransportFactory: → CLI Historical transport (kiloSessionId=%s)',
      resolved.kiloSessionId
    );
    return createCliHistoricalTransport({
      kiloSessionId: resolved.kiloSessionId,
      fetchSnapshot: config.transport.fetchSnapshot,
      onError: config.onError,
    });
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

    resolvedCloudAgentSessionId = resolved.cloudAgentSessionId;

    console.log('[cli-debug] resolveAndConnect: resolved=%o', resolved);

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

  function throwTransportNotConfigured(
    method: 'send' | 'interrupt' | 'answer' | 'reject' | 'respondToPermission'
  ): never {
    throw new Error(`CloudAgentSession transport.${method} is not configured`);
  }

  function commandSessionId(): CloudAgentSessionId {
    if (!resolvedCloudAgentSessionId) {
      throw new Error('Session not resolved yet — call connect() and wait for resolution');
    }
    return resolvedCloudAgentSessionId;
  }

  return {
    storage,
    state: serviceState,
    send: payload => {
      if (transport?.sendCommand) {
        const parts = [{ type: 'text' as const, text: payload.prompt }];
        const agent = payload.mode || undefined;
        const model = payload.model || undefined;
        return transport.sendCommand('send_message', {
          sessionID: config.kiloSessionId,
          parts,
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
        });
      }
      const send = config.transport.send;
      if (!send) {
        throwTransportNotConfigured('send');
      }
      return send({ ...payload, sessionId: commandSessionId() });
    },
    interrupt: () => {
      if (transport?.sendCommand) {
        return transport.sendCommand('interrupt', {});
      }
      const interrupt = config.transport.interrupt;
      if (!interrupt) {
        throwTransportNotConfigured('interrupt');
      }
      return interrupt({ sessionId: commandSessionId() });
    },
    answer: payload => {
      if (transport?.sendCommand) {
        return transport.sendCommand('question_reply', {
          requestId: payload.requestId,
          answers: payload.answers,
        });
      }
      const answer = config.transport.answer;
      if (!answer) {
        throwTransportNotConfigured('answer');
      }
      return answer({ ...payload, sessionId: commandSessionId() });
    },
    reject: payload => {
      if (transport?.sendCommand) {
        return transport.sendCommand('permission_respond', {
          requestId: payload.requestId,
          accepted: false,
        });
      }
      const reject = config.transport.reject;
      if (!reject) {
        throwTransportNotConfigured('reject');
      }
      return reject({ ...payload, sessionId: commandSessionId() });
    },
    respondToPermission: payload => {
      if (transport?.sendCommand) {
        return transport.sendCommand('permission_respond', {
          requestId: payload.requestId,
          response: payload.response,
        });
      }
      const respondToPermission = config.transport.respondToPermission;
      if (!respondToPermission) {
        throwTransportNotConfigured('respondToPermission');
      }
      return respondToPermission({ ...payload, sessionId: commandSessionId() });
    },
    get canSend() {
      return transport?.sendCommand !== undefined || config.transport.send !== undefined;
    },
    get canInterrupt() {
      return (
        transport?.sendCommand !== undefined ||
        (config.transport.interrupt !== undefined && resolvedCloudAgentSessionId !== null)
      );
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
      resolvedCloudAgentSessionId = null;
      connectGeneration += 1;
      serviceState.setActivity({ type: 'connecting' });
      void resolveAndConnect(connectGeneration);
    },
    disconnect() {
      if (transport) {
        transport.disconnect();
        transport = null;
      }
    },
    destroy() {
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
  CloudAgentSessionTransportAnswerInput,
  CloudAgentSessionTransportInterruptInput,
  CloudAgentSessionTransportRejectInput,
  CloudAgentSessionTransportRespondToPermissionInput,
  PermissionResponse,
};
