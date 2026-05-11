/**
 * CLI live transport — connects to the UserConnectionDO WebSocket, subscribes
 * to a live CLI session, normalizes events, and routes them through TransportSink.
 * Uses createBaseConnection() for WebSocket lifecycle/reconnection.
 */
import { createBaseConnection } from './base-connection';
import type { Connection, ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import { normalizeCliEvent, isChatEvent } from './normalizer';
import {
  cliConnectionDataSchema,
  heartbeatDataSchema,
  sessionsListDataSchema,
  webInboundMessageSchema,
  type WebInboundMessage,
} from './schemas';
import { cloudAgentSdkRuntime } from './runtime';
import type { TransportFactory, TransportSendPayload, TransportSink } from './transport';
import type { KiloSessionId, SessionSnapshot } from './types';
import type { UserWebConnection } from './user-web-connection';

type CliLiveTransportConfig = {
  kiloSessionId: KiloSessionId;
  sharedUserWebConnection?: UserWebConnection;
  websocketUrl?: string;
  getAuthToken?: () => string | Promise<string>;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onError?: (message: string) => void;
  lifecycleHooks?: ConnectionLifecycleHooks;
  websocketHeaders?: WebSocketHeaders;
};

const COMMAND_TIMEOUT_MS = 30_000;

function createCliLiveTransport(config: CliLiveTransportConfig): TransportFactory {
  return (sink: TransportSink) => {
    let generation = 0;
    let authToken = '';
    let baseConnection: Connection | null = null;
    let currentWs: WebSocket | null = null;
    let sessionStopped = false;
    let ownerConnectionId: string | null = null;
    const pendingCommands = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (reason: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();

    function replaySnapshot(snapshot: SessionSnapshot): void {
      sink.onServiceEvent({ type: 'session.created', info: snapshot.info });

      for (const msg of snapshot.messages) {
        sink.onChatEvent({ type: 'message.updated', info: msg.info });

        for (const part of msg.parts) {
          sink.onChatEvent({ type: 'message.part.updated', part });
        }
      }
    }

    function handleEventMessage(
      sessionId: string,
      parentSessionId: string | undefined,
      event: string,
      data: unknown
    ): void {
      if (sessionId !== config.kiloSessionId && parentSessionId !== config.kiloSessionId) return;

      const normalized = normalizeCliEvent(event, data);
      if (!normalized) return;

      if (isChatEvent(normalized)) {
        sink.onChatEvent(normalized);
      } else {
        sink.onServiceEvent(normalized);
      }
    }

    function stopForDisconnectedSession(): void {
      if (sessionStopped) return;
      sink.onServiceEvent({ type: 'stopped', reason: 'disconnected' });
      sessionStopped = true;
    }

    function handleSystemMessage(event: string, data: unknown): void {
      if (event === 'cli.disconnected') {
        const parsed = cliConnectionDataSchema.safeParse(data);
        if (parsed.success && ownerConnectionId === parsed.data.connectionId) {
          stopForDisconnectedSession();
        }
        return;
      }

      if (event === 'sessions.list') {
        const parsed = sessionsListDataSchema.safeParse(data);
        if (!parsed.success) return;

        const session = parsed.data.sessions.find(s => s.id === config.kiloSessionId);
        if (session) {
          ownerConnectionId = session.connectionId;
          sessionStopped = false;
          return;
        }

        stopForDisconnectedSession();
        return;
      }

      if (event === 'sessions.heartbeat') {
        const parsed = heartbeatDataSchema.safeParse(data);
        if (!parsed.success) return;

        const session = parsed.data.sessions.find(s => s.id === config.kiloSessionId);
        if (session) {
          ownerConnectionId = parsed.data.connectionId;
          sessionStopped = false;
          return;
        }

        if (ownerConnectionId === parsed.data.connectionId) {
          stopForDisconnectedSession();
        }
      }
    }

    function handleInboundMessage(msg: WebInboundMessage): void {
      switch (msg.type) {
        case 'event':
          handleEventMessage(msg.sessionId, msg.parentSessionId, msg.event, msg.data);
          break;
        case 'system':
          handleSystemMessage(msg.event, msg.data);
          break;
        case 'response': {
          const pending = pendingCommands.get(msg.id);
          if (!pending) break;
          clearTimeout(pending.timer);
          pendingCommands.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Command failed'));
          } else {
            pending.resolve(msg.result);
          }
          break;
        }
      }
    }

    function openBaseConnection(expectedGeneration: number): void {
      if (expectedGeneration !== generation) return;
      if (!config.websocketUrl) return;

      baseConnection = createBaseConnection({
        lifecycleHooks: config.lifecycleHooks,
        websocketHeaders: config.websocketHeaders,
        buildUrl: () => `${config.websocketUrl}?token=${authToken}`,
        parseMessage: (data: unknown) => {
          if (typeof data !== 'string') return null;
          try {
            const parsed: unknown = JSON.parse(data);
            const r = webInboundMessageSchema.safeParse(parsed);
            if (!r.success) return null;
            return { type: 'event', payload: r.data };
          } catch {
            return null;
          }
        },
        onEvent: payload => {
          handleInboundMessage(payload);
        },
        onOpen: (ws: WebSocket) => {
          currentWs = ws;
          sessionStopped = false;
          ownerConnectionId = null;
          ws.send(JSON.stringify({ type: 'subscribe', sessionId: config.kiloSessionId }));
        },
        onConnected: () => {},
        onReconnected: () => {
          if (expectedGeneration !== generation) return;
          if (!config.fetchSnapshot) return;
          void config.fetchSnapshot(config.kiloSessionId).then(
            snapshot => {
              if (expectedGeneration !== generation) return;
              replaySnapshot(snapshot);
            },
            () => {
              // Snapshot refetch failure on reconnect is non-fatal
            }
          );
        },
        onDisconnected: () => {},
        onError: config.onError,
        isAuthFailure: (event: CloseEvent) => event.code === 4001 || event.code === 1008,
        refreshAuth: async () => {
          if (!config.getAuthToken) return;
          authToken = await config.getAuthToken();
        },
      });

      baseConnection.connect();
    }

    function startConnection(expectedGeneration: number): void {
      if (expectedGeneration !== generation) return;

      if (!config.fetchSnapshot) {
        openBaseConnection(expectedGeneration);
        return;
      }

      void config.fetchSnapshot(config.kiloSessionId).then(
        snapshot => {
          if (expectedGeneration !== generation) return;
          replaySnapshot(snapshot);
          openBaseConnection(expectedGeneration);
        },
        (error: unknown) => {
          if (expectedGeneration !== generation) return;
          const message = error instanceof Error ? error.message : 'Failed to fetch snapshot';
          config.onError?.(message);
          // Still try to connect for live events even if snapshot fails
          openBaseConnection(expectedGeneration);
        }
      );
    }

    function rawSendCommand(command: string, data: unknown): Promise<unknown> {
      if (config.sharedUserWebConnection) {
        return config.sharedUserWebConnection.sendCommand(config.kiloSessionId, command, data);
      }
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('WebSocket is not connected'));
      }
      const id = cloudAgentSdkRuntime.randomUUID();
      const ws = currentWs;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCommands.delete(id);
          reject(new Error('Command timed out'));
        }, COMMAND_TIMEOUT_MS);
        pendingCommands.set(id, { resolve, reject, timer });
        ws.send(
          JSON.stringify({
            type: 'command',
            id,
            command,
            sessionId: config.kiloSessionId,
            data,
          })
        );
      });
    }

    return {
      connect() {
        generation += 1;
        const expectedGeneration = generation;

        // Clean up any existing connection
        if (baseConnection) {
          baseConnection.destroy();
          baseConnection = null;
        }
        currentWs = null;
        sessionStopped = false;
        ownerConnectionId = null;

        if (config.sharedUserWebConnection) {
          const replaySharedSnapshot = (reportError: boolean): void => {
            if (!config.fetchSnapshot) return;
            void config.fetchSnapshot(config.kiloSessionId).then(
              snapshot => {
                if (expectedGeneration !== generation) return;
                replaySnapshot(snapshot);
              },
              (error: unknown) => {
                if (!reportError || expectedGeneration !== generation) return;
                const message = error instanceof Error ? error.message : 'Failed to fetch snapshot';
                config.onError?.(message);
              }
            );
          };
          replaySharedSnapshot(true);
          const offCli = config.sharedUserWebConnection.onCliEvent(config.kiloSessionId, msg => {
            handleEventMessage(msg.sessionId, msg.parentSessionId, msg.event, msg.data);
          });
          const offSystem = config.sharedUserWebConnection.onSystemEvent(msg => {
            handleSystemMessage(msg.event, msg.data);
          });
          const offReconnect = config.sharedUserWebConnection.onReconnect(() => {
            replaySharedSnapshot(false);
          });
          config.sharedUserWebConnection.connect();
          const release = config.sharedUserWebConnection.subscribeToCliSession(
            config.kiloSessionId
          );
          baseConnection = {
            connect: () => {},
            disconnect: () => {
              offCli();
              offSystem();
              offReconnect();
              release();
            },
            destroy: () => {
              offCli();
              offSystem();
              offReconnect();
              release();
            },
          };
          return;
        }

        if (!config.getAuthToken) {
          config.onError?.('Failed to get auth token');
          return;
        }

        let tokenResult: string | Promise<string>;
        try {
          tokenResult = config.getAuthToken();
        } catch {
          config.onError?.('Failed to get auth token');
          return;
        }

        if (typeof tokenResult === 'string') {
          authToken = tokenResult;
          startConnection(expectedGeneration);
          return;
        }

        void tokenResult.then(
          token => {
            if (expectedGeneration !== generation) return;
            authToken = token;
            startConnection(expectedGeneration);
          },
          () => {
            if (expectedGeneration !== generation) return;
            config.onError?.('Failed to get auth token');
          }
        );
      },

      send: (input: { payload: TransportSendPayload }) => {
        // CLI live transport does not yet support structured slash command
        // invocation — kilo CLI's command API needs to be plumbed through
        // its own raw protocol command. Reject explicitly so callers see
        // a clear error rather than a silently-dropped command.
        if (input.payload.type === 'command') {
          return Promise.reject(
            new Error('Slash commands are not supported on the CLI live transport yet')
          );
        }
        const p = input.payload;
        return rawSendCommand('send_message', {
          sessionID: config.kiloSessionId,
          parts: [{ type: 'text', text: p.prompt }],
          ...(p.mode ? { agent: p.mode } : {}),
          ...(p.model ? { model: p.model } : {}),
          ...(p.variant ? { variant: p.variant } : {}),
        });
      },
      interrupt: () => rawSendCommand('interrupt', {}),
      answer: (payload: { requestId: string; answers: unknown }) =>
        rawSendCommand('question_reply', {
          requestID: payload.requestId,
          answers: payload.answers,
        }),
      reject: (payload: { requestId: string }) =>
        rawSendCommand('question_reject', {
          requestID: payload.requestId,
        }),
      respondToPermission: (payload: { requestId: string; response: unknown }) =>
        rawSendCommand('permission_respond', {
          requestID: payload.requestId,
          reply: payload.response,
        }),
      acceptSuggestion: (payload: { requestId: string; index: number }) =>
        rawSendCommand('suggestion_accept', {
          requestID: payload.requestId,
          index: payload.index,
        }),
      dismissSuggestion: (payload: { requestId: string }) =>
        rawSendCommand('suggestion_dismiss', {
          requestID: payload.requestId,
        }),

      disconnect() {
        generation += 1;

        for (const [id, entry] of pendingCommands) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Transport disconnected'));
          pendingCommands.delete(id);
        }

        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({ type: 'unsubscribe', sessionId: config.kiloSessionId }));
        }

        if (baseConnection) {
          baseConnection.disconnect();
          baseConnection = null;
        }
        currentWs = null;
      },

      destroy() {
        generation += 1;

        for (const [id, entry] of pendingCommands) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Transport disconnected'));
          pendingCommands.delete(id);
        }

        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({ type: 'unsubscribe', sessionId: config.kiloSessionId }));
        }

        if (baseConnection) {
          baseConnection.destroy();
          baseConnection = null;
        }
        currentWs = null;
      },
    };
  };
}

export { createCliLiveTransport };
export type { CliLiveTransportConfig };
