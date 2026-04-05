/**
 * Cloud Agent transport — wraps createConnection to normalize raw wire events
 * and route them to separate chat/service sinks via the Transport interface.
 *
 * Messages are pre-loaded from the REST API and replayed into the sink before
 * the WebSocket connects with `?replay=false`, avoiding a blank flash while
 * the DO replays stored events.
 */
import { CLOUD_AGENT_NEXT_WS_URL } from '@/lib/constants';
import { createConnection, type Connection } from './cloud-agent-connection';
import { normalize, isChatEvent } from './normalizer';
import type { ServiceEvent } from './normalizer';
import type { CloudAgentSessionId, KiloSessionId, SessionSnapshot } from './types';
import type { CloudAgentApi, TransportFactory, TransportSink } from './transport';

type CloudAgentTransportConfig = {
  sessionId: CloudAgentSessionId;
  kiloSessionId: KiloSessionId;
  api: CloudAgentApi;
  getTicket: (sessionId: CloudAgentSessionId) => string | Promise<string>;
  fetchSnapshot: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  websocketBaseUrl?: string;
  onError?: (message: string) => void;
};

function createCloudAgentTransport(config: CloudAgentTransportConfig): TransportFactory {
  const websocketBaseUrl = config.websocketBaseUrl ?? CLOUD_AGENT_NEXT_WS_URL;

  function buildWebsocketUrl(): string {
    const url = new URL('/stream', websocketBaseUrl);
    url.searchParams.set('cloudAgentSessionId', config.sessionId);
    url.searchParams.set('replay', 'false');
    return url.toString();
  }

  return (sink: TransportSink) => {
    let connection: Connection | null = null;
    let lifecycleGeneration = 0;
    let stoppedReceived = false;

    function closeConnection(mode: 'disconnect' | 'destroy'): void {
      if (!connection) return;

      if (mode === 'disconnect') {
        connection.disconnect();
      } else {
        connection.destroy();
      }

      connection = null;
    }

    function replaySnapshot(snapshot: SessionSnapshot): void {
      sink.onServiceEvent({ type: 'session.created', info: snapshot.info });

      for (const msg of snapshot.messages) {
        sink.onChatEvent({ type: 'message.updated', info: msg.info });

        for (const part of msg.parts) {
          sink.onChatEvent({ type: 'message.part.updated', part });
        }
      }
    }

    function connectWebSocket(ticket: string, expectedGeneration: number): void {
      if (expectedGeneration !== lifecycleGeneration) return;

      const stoppedEvent: ServiceEvent = { type: 'stopped', reason: 'disconnected' };

      const nextConnection = createConnection({
        websocketUrl: buildWebsocketUrl(),
        ticket,
        onEvent: raw => {
          const event = normalize(raw);
          if (!event) return;

          if (event.type === 'stopped') {
            stoppedReceived = true;
          }

          if (isChatEvent(event)) {
            sink.onChatEvent(event);
          } else {
            sink.onServiceEvent(event);
          }
        },
        onConnected: () => {},
        onReconnected: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          stoppedReceived = false;
          void config.fetchSnapshot(config.kiloSessionId).then(
            snapshot => {
              if (expectedGeneration !== lifecycleGeneration) return;
              replaySnapshot(snapshot);
            },
            () => {
              // Snapshot refetch failure on reconnect — ignore, live events will still flow
            }
          );
        },
        onDisconnected: () => {},
        onUnexpectedDisconnect: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          if (stoppedReceived) return;
          stoppedReceived = true;
          sink.onServiceEvent(stoppedEvent);
        },
        onError: streamError => config.onError?.(streamError.message),
        onRefreshTicket: () => Promise.resolve(config.getTicket(config.sessionId)),
      });

      connection = nextConnection;

      if (expectedGeneration !== lifecycleGeneration) {
        closeConnection('destroy');
        return;
      }

      nextConnection.connect();
    }

    function handleTicketError(error: unknown, expectedGeneration: number): void {
      if (expectedGeneration !== lifecycleGeneration) return;
      const message = error instanceof Error ? error.message : 'Failed to get stream ticket';
      config.onError?.(message);
    }

    return {
      connect() {
        closeConnection('destroy');
        lifecycleGeneration += 1;
        stoppedReceived = false;
        const expectedGeneration = lifecycleGeneration;

        void Promise.all([
          Promise.resolve(config.getTicket(config.sessionId)),
          config.fetchSnapshot(config.kiloSessionId),
        ])
          .then(([ticket, snapshot]) => {
            if (expectedGeneration !== lifecycleGeneration) return;
            replaySnapshot(snapshot);
            connectWebSocket(ticket, expectedGeneration);
          })
          .catch(error => {
            handleTicketError(error, expectedGeneration);
          });
      },

      disconnect() {
        lifecycleGeneration += 1;
        closeConnection('disconnect');
      },

      destroy() {
        lifecycleGeneration += 1;
        closeConnection('destroy');
      },

      send: payload => config.api.send({ sessionId: config.sessionId, ...payload }),
      interrupt: () => config.api.interrupt({ sessionId: config.sessionId }),
      answer: payload => config.api.answer({ sessionId: config.sessionId, ...payload }),
      reject: payload => config.api.reject({ sessionId: config.sessionId, ...payload }),
      respondToPermission: payload =>
        config.api.respondToPermission({ sessionId: config.sessionId, ...payload }),
    };
  };
}

export { createCloudAgentTransport };
export type { CloudAgentTransportConfig };
