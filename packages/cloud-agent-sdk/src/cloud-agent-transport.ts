/**
 * Cloud Agent transport — wraps createConnection to normalize raw wire events
 * and route them to separate chat/service sinks via the Transport interface.
 *
 * REST messages seed the transcript; WebSocket replay closes ingest lag while
 * service-state notifications are batched until bootstrap completes.
 */
import { createConnection, type Connection } from './cloud-agent-connection';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import { normalize, isChatEvent } from './normalizer';
import type { ServiceEvent } from './normalizer';
import { partSettledAt } from './part-utils';
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
  onInitialPageLoaded?: ((page: SessionSnapshotPage) => void) | undefined;
  websocketBaseUrl: string;
  onError?: ((message: string) => void) | undefined;
  lifecycleHooks?: ConnectionLifecycleHooks | undefined;
  websocketHeaders?: WebSocketHeaders | undefined;
};

// Snapshot reads run beside the live socket: a failed read costs the transcript
// replay, never the live connection, so it is reported once and retried with a
// short bounded backoff that stays well inside a user-noticeable wait.
const SNAPSHOT_READ_MAX_RETRIES = 3;
const SNAPSHOT_READ_BASE_DELAY_MS = 500;
const SNAPSHOT_READ_MAX_DELAY_MS = 4000;

/** One settled snapshot read. Reads never reject; a failure is a value. */
type SnapshotRead =
  | { kind: 'page'; page: SessionSnapshotPage }
  | { kind: 'typed'; outcome: { kind: 'retryable_failure' | 'invalid_data' | 'too_large' } }
  | { kind: 'missing' }
  | { kind: 'rejected'; error: unknown };

function snapshotReadFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Session history temporarily unavailable';
}

function typedSnapshotFailureMessage(outcome: {
  kind: 'retryable_failure' | 'invalid_data' | 'too_large';
}): string {
  if (outcome.kind === 'retryable_failure') return 'Session history temporarily unavailable';
  if (outcome.kind === 'too_large') return 'Session history too large to load';
  return 'Session history is unavailable';
}

function createCloudAgentTransport(config: CloudAgentTransportConfig): TransportFactory {
  const websocketBaseUrl = config.websocketBaseUrl;

  return (sink: TransportSink) => {
    let connection: Connection | null = null;
    let lifecycleGeneration = 0;
    let stoppedReceived = false;
    let replaying = true;
    let awaitingConnectedSnapshot = true;
    // Last persisted event id seen on the wire (eventId 0 is the synthetic
    // sentinel). Used as a replay cursor on reconnect: the DO replays every
    // stored event after it, so content produced while the socket was dead is
    // re-delivered in order instead of being left to snapshot freshness.
    let lastEventId: number | null = null;
    // True once the manager has been handed an initial page, so a reconnect
    // catch-up can tell whether its page is still the session's only seed.
    let initialPageRecorded = false;
    // Pending bounded retry of a failed snapshot read, and whether this failure
    // episode already reached the error callback (one report per episode).
    let snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotFailureReported = false;

    function cancelSnapshotRetry(): void {
      clearTimeout(snapshotRetryTimer ?? undefined);
      snapshotRetryTimer = null;
      snapshotFailureReported = false;
    }

    function startReplay(): void {
      replaying = true;
      awaitingConnectedSnapshot = true;
      stoppedReceived = false;
      sink.onReplayStarted?.();
    }

    function finishReplay(): void {
      if (!replaying) return;
      replaying = false;
      sink.onReplayComplete?.();
    }

    function cancelReplay(): void {
      if (!replaying) return;
      replaying = false;
      stoppedReceived = false;
      sink.onReplayCanceled?.();
    }

    function buildWebsocketUrl(): string {
      const url = new URL('/stream', websocketBaseUrl);
      url.searchParams.set('cloudAgentSessionId', config.sessionId);
      url.searchParams.set('bootstrap', 'true');
      if (lastEventId !== null) {
        // Reconnect cursor or initial watermark: the DO replays everything
        // after this id — either a live cursor from the wire, or the
        // event-log watermark from the initial bounded page.
        url.searchParams.set('fromId', String(lastEventId));
      } else {
        // No cursor and no watermark: messages are pre-loaded via REST,
        // skip the DO replay.
        url.searchParams.set('replay', 'false');
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
          const settledAt = partSettledAt(part);
          sink.onChatEvent({
            type: 'message.part.updated',
            part,
            ...(settledAt === undefined ? {} : { time: settledAt }),
          });
        }
      }
    }

    function snapshotToPage(snapshot: SessionSnapshot): SessionSnapshotPage {
      // The legacy full-snapshot path is retained for callers that haven't
      // migrated to the paginated endpoint yet. Same shape; same effect.
      return {
        info: snapshot.info,
        messages: snapshot.messages,
        nextCursor: null,
        omittedItemCount: 0,
      };
    }

    function replayInitialPage(page: SessionSnapshotPage): void {
      // Seed lastEventId from the page's event-log watermark. A present
      // watermark sets the cursor to 0 so the WebSocket connect uses
      // `fromId=0` — the DO replays every stored event, closing the gap when
      // SessionIngest materialization lags behind the event-log high-water
      // mark. A cursor that live events already advanced is never regressed.
      if (lastEventId === null && page.watermarkEventId != null) lastEventId = 0;
      initialPageRecorded = true;
      config.onInitialPageLoaded?.(page);
      replayPage(page);
    }

    /**
     * One snapshot read. Never rejects: a failed read is a value the caller
     * reports and retries, so it can never cost the live connection.
     */
    async function readSnapshot(): Promise<SnapshotRead> {
      const fetchPage = config.fetchSnapshotPage;
      if (fetchPage) {
        let outcome: SessionSnapshotPageOutcome | null;
        try {
          outcome = await fetchPage(config.kiloSessionId, {});
        } catch (error) {
          return { kind: 'rejected', error };
        }
        if (outcome === null) return { kind: 'missing' };
        if (outcome.kind === 'success') return { kind: 'page', page: outcome };
        return { kind: 'typed', outcome };
      }
      try {
        return {
          kind: 'page',
          page: snapshotToPage(await config.fetchSnapshot(config.kiloSessionId)),
        };
      } catch (error) {
        return { kind: 'rejected', error };
      }
    }

    function reportSnapshotFailure(message: string, expectedGeneration: number): void {
      if (expectedGeneration !== lifecycleGeneration || snapshotFailureReported) return;
      snapshotFailureReported = true;
      config.onError?.(message);
    }

    /**
     * Handle one settled snapshot read: replay a page, or report a failure once
     * per episode while the retry chain keeps running. Returns true when the
     * episode is over, false when the read is worth retrying.
     */
    function applySnapshotRead(
      read: SnapshotRead,
      onPage: (page: SessionSnapshotPage) => void,
      expectedGeneration: number
    ): boolean {
      if (read.kind === 'page') {
        onPage(read.page);
        return true;
      }
      if (read.kind === 'missing') return true;
      const transient = read.kind === 'rejected' || read.outcome.kind === 'retryable_failure';
      reportSnapshotFailure(
        read.kind === 'rejected'
          ? snapshotReadFailureMessage(read.error)
          : typedSnapshotFailureMessage(read.outcome),
        expectedGeneration
      );
      return !transient;
    }

    /**
     * Retry a failed snapshot read with bounded exponential backoff while the
     * lifecycle generation stands. A newer retry chain (a reconnect catch-up)
     * replaces the pending one, so the transport never keeps two in flight.
     */
    function scheduleSnapshotRetry(
      onPage: (page: SessionSnapshotPage) => void,
      expectedGeneration: number,
      retry: number
    ): void {
      if (retry >= SNAPSHOT_READ_MAX_RETRIES) return;
      clearTimeout(snapshotRetryTimer ?? undefined);
      snapshotRetryTimer = setTimeout(
        () => {
          snapshotRetryTimer = null;
          if (expectedGeneration !== lifecycleGeneration) return;
          void readSnapshot().then(read => {
            if (expectedGeneration !== lifecycleGeneration) return;
            if (applySnapshotRead(read, onPage, expectedGeneration)) return;
            scheduleSnapshotRetry(onPage, expectedGeneration, retry + 1);
          });
        },
        Math.min(SNAPSHOT_READ_MAX_DELAY_MS, SNAPSHOT_READ_BASE_DELAY_MS * 2 ** retry)
      );
    }

    /**
     * Read the initial bounded page (newest 50) and replay it. The ticket and
     * the read start together, but only a failed ticket stops the connect: a
     * failed read is reported, retried, and the socket opens without it.
     */
    async function fetchAndReplayInitial(
      expectedGeneration: number
    ): Promise<{ ticket: CloudAgentStreamTicketResult } | null> {
      const [ticket, read] = await Promise.all([
        Promise.resolve(config.getTicket(config.sessionId)),
        readSnapshot(),
      ]);
      if (expectedGeneration !== lifecycleGeneration) return null;
      if (read.kind === 'missing') {
        handleTicketError(new Error('Session not found'), expectedGeneration);
        return null;
      }
      if (!applySnapshotRead(read, replayInitialPage, expectedGeneration)) {
        scheduleSnapshotRetry(replayInitialPage, expectedGeneration, 0);
      }
      // Even on a failed read the websocket is still useful — connect without
      // a snapshot replay. The manager surfaces the error and a retry fills the
      // transcript when the read recovers.
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
          if (expectedGeneration !== lifecycleGeneration || raw.sessionId !== config.sessionId) {
            return;
          }
          // Track high-water mark for reconnect fromId only. Do not filter
          // by eventId: the DO entity-upserts tool/message parts under a
          // stable row id and rebroadcasts that same (or older) id with a
          // newer payload. Dropping those left live tools stuck on empty input.
          // eventId 0 is a synthetic sentinel and never advances the cursor.
          if (raw.eventId > 0 && (lastEventId === null || raw.eventId > lastEventId)) {
            lastEventId = raw.eventId;
          }

          const event = normalize(raw);
          if (!event) return;

          if (event.type === 'bootstrap.complete') {
            finishReplay();
            return;
          }
          if (event.type === 'connected') awaitingConnectedSnapshot = false;
          // Pending interactions are restored separately after connected.
          if (
            awaitingConnectedSnapshot &&
            (event.type === 'question.asked' ||
              event.type === 'question.replied' ||
              event.type === 'question.rejected' ||
              event.type === 'permission.asked' ||
              event.type === 'permission.replied')
          ) {
            return;
          }

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

          if (event.type === 'connected') {
            if (!event.bootstrapPending) finishReplay();
          }
        },
        onConnected: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          startReplay();
        },
        onReconnected: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          startReplay();
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
          // cursor back to the latest 50. The one exception is a session whose
          // initial page never landed: this page is then its only seed.
          cancelSnapshotRetry();
          void readSnapshot().then(read => {
            if (expectedGeneration !== lifecycleGeneration) return;
            const onPage = (page: SessionSnapshotPage): void => {
              if (initialPageRecorded) {
                replayPage(page);
                return;
              }
              replayInitialPage(page);
            };
            if (!applySnapshotRead(read, onPage, expectedGeneration)) {
              scheduleSnapshotRetry(onPage, expectedGeneration, 0);
            }
          });
        },
        onDisconnected: () => {
          if (expectedGeneration !== lifecycleGeneration || !replaying) return;
          sink.onServiceEvent(stoppedEvent);
          cancelReplay();
          stoppedReceived = true;
        },
        onUnexpectedDisconnect: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          if (stoppedReceived && !replaying) return;
          sink.onServiceEvent(stoppedEvent);
          cancelReplay();
          stoppedReceived = true;
        },
        onError: streamError => {
          if (expectedGeneration !== lifecycleGeneration) return;
          config.onError?.(streamError.message);
        },
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

    async function runMutation<T>(mutation: () => Promise<T>): Promise<T> {
      const expectedGeneration = lifecycleGeneration;
      const result = await mutation();
      if (expectedGeneration === lifecycleGeneration) {
        connection?.recoverAfterSuccessfulMutation();
      }
      return result;
    }

    return {
      connect() {
        closeConnection('destroy');
        cancelSnapshotRetry();
        lifecycleGeneration += 1;
        stoppedReceived = false;
        replaying = true;
        awaitingConnectedSnapshot = true;
        initialPageRecorded = false;
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
        cancelReplay();
        cancelSnapshotRetry();
        lifecycleGeneration += 1;
        closeConnection('disconnect');
      },

      destroy() {
        cancelReplay();
        cancelSnapshotRetry();
        lifecycleGeneration += 1;
        closeConnection('destroy');
      },

      send: input =>
        runMutation(() =>
          config.api.send({
            sessionId: config.sessionId,
            payload: normalizeCloudAgentPayload(input.payload),
            ...(input.messageId ? { messageId: input.messageId } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(input.images ? { images: input.images } : {}),
          })
        ),
      interrupt: () => runMutation(() => config.api.interrupt({ sessionId: config.sessionId })),
      dropQueuedMessage: async messageId => {
        const cancelQueuedMessage = config.api.cancelQueuedMessage;
        if (!cancelQueuedMessage) {
          throw new Error('Cloud Agent cancel queued message is not configured');
        }
        return runMutation(() => cancelQueuedMessage({ sessionId: config.sessionId, messageId }));
      },
      answer: payload =>
        runMutation(() => config.api.answer({ sessionId: config.sessionId, ...payload })),
      reject: payload =>
        runMutation(() => config.api.reject({ sessionId: config.sessionId, ...payload })),
      respondToPermission: payload =>
        runMutation(() =>
          config.api.respondToPermission({ sessionId: config.sessionId, ...payload })
        ),
    };
  };
}

export { createCloudAgentTransport };
export type { CloudAgentTransportConfig };
