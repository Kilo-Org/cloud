/**
 * CLI live transport — connects to the UserConnectionDO WebSocket, subscribes
 * to a live CLI session, normalizes events, and routes them through TransportSink.
 * Uses createBaseConnection() for WebSocket lifecycle/reconnection.
 */
import * as z from 'zod';
import { createBaseConnection } from './base-connection';
import type { Connection } from './base-connection';
import { normalizeCliEvent, isChatEvent } from './normalizer';
import { webInboundMessageSchema, heartbeatDataSchema, type WebInboundMessage } from './schemas';
import type { TransportFactory, TransportSink } from './transport';
import type { KiloSessionId, SessionSnapshot } from './types';

type CliLiveTransportConfig = {
  kiloSessionId: KiloSessionId;
  websocketUrl: string;
  getAuthToken: () => string | Promise<string>;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onError?: (message: string) => void;
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
      console.log('[cli-debug] replaySnapshot: %d messages to replay', snapshot.messages.length);
      sink.onServiceEvent({ type: 'session.created', info: snapshot.info });

      for (const msg of snapshot.messages) {
        console.log(
          '[cli-debug] replaySnapshot: message id=%s, parts=%d',
          msg.info.id,
          msg.parts.length
        );
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
      console.log(
        '[cli-debug] handleEventMessage: sessionId=%s, parentSessionId=%s, event=%s, isOurs=%s',
        sessionId,
        parentSessionId,
        event,
        sessionId === config.kiloSessionId || parentSessionId === config.kiloSessionId
      );
      if (sessionId !== config.kiloSessionId && parentSessionId !== config.kiloSessionId) return;

      const normalized = normalizeCliEvent(event, data);
      if (!normalized) return;

      if (isChatEvent(normalized)) {
        sink.onChatEvent(normalized);
      } else {
        sink.onServiceEvent(normalized);
      }
    }

    function handleSystemMessage(event: string, data: unknown): void {
      console.log('[cli-debug] handleSystemMessage: event=%s', event);

      if (event === 'cli.disconnected') {
        const parsed = z.object({ connectionId: z.string() }).safeParse(data);
        const disconnectedId = parsed.success ? parsed.data.connectionId : undefined;
        if (!ownerConnectionId || disconnectedId === ownerConnectionId) {
          if (!sessionStopped) {
            sink.onServiceEvent({ type: 'stopped', reason: 'disconnected' });
            sessionStopped = true;
          }
        }
        return;
      }

      if (event === 'sessions.heartbeat' || event === 'sessions.list') {
        const r = heartbeatDataSchema.safeParse(data);
        if (!r.success) return;

        const session = r.data.sessions.find(s => s.id === config.kiloSessionId);
        if (session) {
          ownerConnectionId = r.data.connectionId;
          return;
        }

        // Session not in this heartbeat — only treat as stopped if this heartbeat
        // is from the connection that owns the session (or we haven't learned the
        // owner yet, in which case sessions.list is the authoritative source).
        const isOwnerHeartbeat = !ownerConnectionId || r.data.connectionId === ownerConnectionId;
        if (isOwnerHeartbeat && !sessionStopped) {
          sink.onServiceEvent({ type: 'stopped', reason: 'disconnected' });
          sessionStopped = true;
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
      console.log('[cli-debug] openBaseConnection: wsUrl=%s', config.websocketUrl);

      baseConnection = createBaseConnection({
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
          console.log('[cli-debug] WebSocket event received: %o', payload);
          handleInboundMessage(payload);
        },
        onOpen: (ws: WebSocket) => {
          console.log(
            '[cli-debug] WebSocket opened, sending subscribe for sessionId=%s',
            config.kiloSessionId
          );
          currentWs = ws;
          sessionStopped = false;
          ownerConnectionId = null;
          ws.send(JSON.stringify({ type: 'subscribe', sessionId: config.kiloSessionId }));
        },
        onConnected: () => {},
        onDisconnected: () => {},
        onError: config.onError,
        isAuthFailure: (event: CloseEvent) => event.code === 4001 || event.code === 1008,
        refreshAuth: async () => {
          authToken = await config.getAuthToken();
        },
      });

      baseConnection.connect();
    }

    function startConnection(expectedGeneration: number): void {
      if (expectedGeneration !== generation) return;
      console.log('[cli-debug] startConnection: hasFetchSnapshot=%s', !!config.fetchSnapshot);

      if (!config.fetchSnapshot) {
        console.log('[cli-debug] startConnection: no fetchSnapshot, opening WebSocket directly');
        openBaseConnection(expectedGeneration);
        return;
      }

      console.log('[cli-debug] startConnection: fetching snapshot...');
      void config.fetchSnapshot(config.kiloSessionId).then(
        snapshot => {
          if (expectedGeneration !== generation) return;
          console.log('[cli-debug] startConnection: snapshot fetched, opening WebSocket');
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
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('WebSocket is not connected'));
      }
      const id = crypto.randomUUID();
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
        console.log(
          '[cli-debug] CliLiveTransport.connect() called, kiloSessionId=%s',
          config.kiloSessionId
        );
        generation += 1;
        const expectedGeneration = generation;

        // Clean up any existing connection
        if (baseConnection) {
          baseConnection.destroy();
          baseConnection = null;
        }
        currentWs = null;

        let tokenResult: string | Promise<string>;
        try {
          tokenResult = config.getAuthToken();
        } catch {
          config.onError?.('Failed to get auth token');
          return;
        }

        if (typeof tokenResult === 'string') {
          authToken = tokenResult;
          console.log('[cli-debug] CliLiveTransport: auth token obtained');
          startConnection(expectedGeneration);
          return;
        }

        void tokenResult.then(
          token => {
            if (expectedGeneration !== generation) return;
            authToken = token;
            console.log('[cli-debug] CliLiveTransport: auth token obtained');
            startConnection(expectedGeneration);
          },
          () => {
            if (expectedGeneration !== generation) return;
            config.onError?.('Failed to get auth token');
          }
        );
      },

      send: (payload: { prompt: string; mode?: string; model?: string; variant?: string }) =>
        rawSendCommand('send_message', {
          sessionID: config.kiloSessionId,
          parts: [{ type: 'text', text: payload.prompt }],
          ...(payload.mode ? { agent: payload.mode } : {}),
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.variant ? { variant: payload.variant } : {}),
        }),
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
