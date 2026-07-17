/**
 * Cloud Agent transport — wraps createConnection to normalize raw wire events
 * and route them to separate chat/service sinks via the Transport interface.
 *
 * Messages are pre-loaded from the REST API and replayed into the sink before
 * the WebSocket connects with `?replay=false`, avoiding a blank flash while
 * the DO replays stored events.
 */
import { createConnection, type Connection } from './cloud-agent-connection';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import { normalize, isChatEvent } from './normalizer';
import type { ServiceEvent } from './normalizer';
import type {
  CloudAgentSessionId,
  KiloSessionId,
  SessionSnapshot,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
} from './types';
import type {
  CloudAgentApi,
  CloudAgentSendPayload,
  CloudAgentStreamTicketResult,
  TransportFactory,
  TransportSendPayload,
  TransportSink,
} from './transport';

function normalizeCloudAgentPayload(payload: TransportSendPayload): CloudAgentSendPayload {
  if (payload.type === 'command') return payload;
  if (!payload.mode) throw new Error('Cloud Agent mode is required');
  if (!payload.model) throw new Error('Cloud Agent model is required');
  if (payload.model.providerID !== 'kilo') {
    throw new Error('Cloud Agent only supports Kilo models');
  }

  return {
    type: 'prompt',
    prompt: payload.prompt,
    mode: payload.mode,
    model: payload.model.modelID,
    ...(payload.variant ? { variant: payload.variant } : {}),
  };
}

type CloudAgentTransportConfig = {
  sessionId: CloudAgentSessionId;
  kiloSessionId: KiloSessionId;
  api: CloudAgentApi;
  getTicket: (
    sessionId: CloudAgentSessionId
  ) => CloudAgentStreamTicketResult | Promise<CloudAgentStreamTicketResult>;
  fetchSnapshot: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  /**
   * Page-aware root snapshot fetch. When provided, the transport uses it for
   * its initial bounded read (newest 50) instead of `fetchSnapshot`, and for
   * any reconnect snapshot replays. The transport calls `onInitialPageLoaded`
   * after a successful initial read so the manager can record the cursor.
   */
  fetchSnapshotPage?: (
    kiloSessionId: KiloSessionId,
    options: { cursor?: string }
  ) => Promise<SessionSnapshotPageOutcome | null>;
  /** Called after a successful initial bounded page read. */
  onInitialPageLoaded?: (page: SessionSnapshotPage) => void;
  websocketBaseUrl: string;
  onError?: (message: string) => void;
  lifecycleHooks?: ConnectionLifecycleHooks;
  websocketHeaders?: WebSocketHeaders;
};

function createCloudAgentTransport(config: CloudAgentTransportConfig): TransportFactory {
  const websocketBaseUrl = config.websocketBaseUrl;

  return (sink: TransportSink) => {
    let connection: Connection | null = null;
    let lifecycleGeneration = 0;
    let stoppedReceived = false;
    // Last persisted event id seen on the wire (eventId 0 is the synthetic
    // sentinel). Used as a replay cursor on reconnect: the DO replays every
    // stored event after it, so content produced while the socket was dead is
    // re-delivered in order instead of being left to snapshot freshness.
    let lastEventId: number | null = null;

    function buildWebsocketUrl(): string {
      const url = new URL('/stream', websocketBaseUrl);
      url.searchParams.set('cloudAgentSessionId', config.sessionId);
      if (lastEventId === null) {
        // First connect: messages are pre-loaded via REST, skip the full replay.
        url.searchParams.set('replay', 'false');
      } else {
        url.searchParams.set('fromId', String(lastEventId));
      }
      return url.toString();
    }

    function closeConnection(mode: 'disconnect' | 'destroy'): void {
      if (!connection) return;

      if (mode === 'disconnect') {
        connection.disconnect();
      } else {
        connection.destroy();
      }

      connection = null;
    }

    function replayPage(page: SessionSnapshotPage): void {
      sink.onServiceEvent({ type: 'session.created', info: page.info });

      for (const msg of page.messages) {
        sink.onChatEvent({ type: 'message.updated', info: msg.info });

        for (const part of msg.parts) {
          sink.onChatEvent({ type: 'message.part.updated', part });
        }
      }
    }

    function replaySnapshot(snapshot: SessionSnapshot): void {
      // The legacy full-snapshot path is retained for callers that haven't
      // migrated to the paginated endpoint yet. Same shape; same effect.
      replayPage({
        info: snapshot.info,
        messages: snapshot.messages,
        nextCursor: null,
        omittedItemCount: 0,
      });
    }

    /** Fetch the initial bounded page (newest 50) and replay it. */
    async function fetchAndReplayInitial(
      expectedGeneration: number
    ): Promise<{ ticket: CloudAgentStreamTicketResult } | null> {
      const fetchPage = config.fetchSnapshotPage;
      if (fetchPage) {
        const [ticket, page] = await Promise.all([
          Promise.resolve(config.getTicket(config.sessionId)),
          fetchPage(config.kiloSessionId, {}),
        ]);
        if (expectedGeneration !== lifecycleGeneration) return null;
        if (page === null) {
          handleTicketError(new Error('Session not found'), expectedGeneration);
          return null;
        }
        if (page.kind === 'success') {
          config.onInitialPageLoaded?.(page);
          replayPage(page);
          return { ticket };
        }
        // Typed failure on initial load — surface via the standard error
        // channel (same path as a thrown fetch failure) and still try to
        // connect so the user can recover via live events.
        handleTicketError(
          new Error(
            page.kind === 'retryable_failure'
              ? 'Session history temporarily unavailable'
              : page.kind === 'too_large'
                ? 'Session history too large to load'
                : 'Session history is unavailable'
          ),
          expectedGeneration
        );
        // Even on a typed failure, the websocket is still useful — connect
        // without a snapshot replay. The manager will surface the error.
        return { ticket };
      }
      const [ticket, snapshot] = await Promise.all([
        Promise.resolve(config.getTicket(config.sessionId)),
        config.fetchSnapshot(config.kiloSessionId),
      ]);
      if (expectedGeneration !== lifecycleGeneration) return null;
      replaySnapshot(snapshot);
      return { ticket };
    }

    function connectWebSocket(
      ticket: CloudAgentStreamTicketResult,
      expectedGeneration: number
    ): void {
      if (expectedGeneration !== lifecycleGeneration) return;

      const stoppedEvent: ServiceEvent = { type: 'stopped', reason: 'transport-disconnected' };

      const nextConnection = createConnection({
        websocketUrl: buildWebsocketUrl,
        ticket,
        lifecycleHooks: config.lifecycleHooks,
        websocketHeaders: config.websocketHeaders,
        onEvent: raw => {
          if (raw.eventId > 0) {
            lastEventId = raw.eventId;
          }

          const event = normalize(raw);
          if (!event) return;

          // Cloud Agent sessions have no command path for accepting or
          // dismissing suggestions, so drop these events before they reach the
          // sink — otherwise the UI would render a card whose buttons throw.
          if (
            event.type === 'suggestion.shown' ||
            event.type === 'suggestion.accepted' ||
            event.type === 'suggestion.dismissed'
          ) {
            return;
          }

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
          // With a replay cursor the socket itself re-delivers everything
          // missed while dead — replaying a (possibly stale) snapshot on top
          // would overwrite newer parts. Only fall back to the snapshot when
          // no cursor exists yet.
          if (lastEventId !== null) return;
          // Reconnect replays use the bounded page fetch (newest 50) to
          // avoid overwriting older messages the user has already loaded via
          // `loadOlderMessages`. The manager already has the cursor from
          // the initial connect, so we deliberately skip `onInitialPageLoaded`
          // here — a reconnect must never reset the user's older-pages
          // cursor back to the latest 50.
          const replayRefetch = config.fetchSnapshotPage
            ? config.fetchSnapshotPage(config.kiloSessionId, {}).then(
                page => {
                  if (expectedGeneration !== lifecycleGeneration) return;
                  if (page && page.kind === 'success') {
                    replayPage(page);
                  }
                },
                () => undefined
              )
            : config.fetchSnapshot(config.kiloSessionId).then(
                snapshot => {
                  if (expectedGeneration !== lifecycleGeneration) return;
                  replaySnapshot(snapshot);
                },
                () => undefined
              );
          void replayRefetch;
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

        void fetchAndReplayInitial(expectedGeneration)
          .then(result => {
            if (!result) return;
            connectWebSocket(result.ticket, expectedGeneration);
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

      send: async input =>
        config.api.send({
          sessionId: config.sessionId,
          payload: normalizeCloudAgentPayload(input.payload),
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.images ? { images: input.images } : {}),
        }),
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
