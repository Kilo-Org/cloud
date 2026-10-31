/**
 * Cloud Agent transport — wraps createConnection to normalize raw wire events
 * and route them to separate chat/service sinks via the Transport interface.
 *
 * Snapshots seed the transcript; WebSocket replay closes the snapshot gap while
 * service-state notifications are batched until bootstrap completes.
 */
import { createConnection, type Connection } from './cloud-agent-connection';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import { isChatEvent, type NormalizedEvent } from './normalizer';
import { createConversationSourceReader } from './conversation-source';
import type { CloudAgentEvent } from './cloud-conversation-schemas';
import type { ServiceEvent } from './normalizer';
import {
  replaySnapshotPage,
  replayStoredMessages,
  sessionSnapshotFailureMessage,
  snapshotPageFromSnapshot,
} from './snapshot-page';
import {
  cloudMessageInfoSchema,
  cloudMessagePartSchema,
  cloudSessionMessagesPageSchema,
} from './schemas';
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
  fetchSnapshot?: ((kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>) | undefined;
  fetchCloudSnapshotPage?:
    | ((
        sessionId: CloudAgentSessionId,
        options: { cursor?: string; limit?: number; kiloSessionId?: string }
      ) => Promise<unknown>)
    | undefined;
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
// short bounded backoff (500 ms, 1 s, 2 s) that stays well inside a
// user-noticeable wait.
const SNAPSHOT_READ_MAX_RETRIES = 3;
const SNAPSHOT_READ_BASE_DELAY_MS = 500;

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
const MAX_EVENT_VERSIONS = 2048;

function createCloudAgentTransport(config: CloudAgentTransportConfig): TransportFactory {
  const websocketBaseUrl = config.websocketBaseUrl;
  const workspaceSession = config.sessionId.startsWith('workspace_');
  if (workspaceSession && !config.fetchCloudSnapshotPage) {
    throw new Error('Cloud Agent workspace sessions require fetchCloudSnapshotPage');
  }

  return (sink: TransportSink) => {
    const sources = createConversationSourceReader();
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
    let lastUpdateCursor = 0;
    const eventVersions = new Map<number, number>();
    const sessionInfoVersions = new Map<string, number>();

    function deliverEvent(
      raw: CloudAgentEvent,
      event: NormalizedEvent,
      sourceVersion: 'v1' | 'v2'
    ): void {
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
          event.type === 'permission.unreadable' ||
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
        if (!workspaceSession) {
          sink.onChatEvent(event);
          return;
        }
        if (raw.cursor === undefined) return;
        const version = {
          sourceId: config.sessionId,
          eventId: raw.eventId,
          cursor: raw.cursor,
        };
        if (sourceVersion === 'v2') {
          sink.onChatEvent({ ...event, version });
        } else if (event.type === 'message.updated') {
          const info = cloudMessageInfoSchema.safeParse(event.info);
          if (info.success) sink.onChatEvent({ ...event, info: info.data, version });
        } else if (event.type === 'message.part.updated') {
          const part = cloudMessagePartSchema.safeParse(event.part);
          if (part.success) {
            const textOmitted =
              (event.part.type === 'text' || event.part.type === 'reasoning') &&
              !('text' in event.part);
            sink.onChatEvent({
              ...event,
              part: part.data,
              version,
              ...(textOmitted ? { textOmitted: true } : {}),
            });
          }
        } else {
          sink.onChatEvent({ ...event, version });
        }
      } else {
        if (
          workspaceSession &&
          (event.type === 'session.created' || event.type === 'session.updated')
        ) {
          if (raw.cursor === undefined) return;
          const previous = sessionInfoVersions.get(event.info.id);
          if (previous !== undefined && raw.cursor <= previous) return;
          sessionInfoVersions.set(event.info.id, raw.cursor);
        }
        sink.onServiceEvent(event);
      }

      if (event.type === 'connected') {
        if (!event.bootstrapPending) finishReplay();
      }
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
      if (workspaceSession) {
        url.searchParams.set('afterCursor', String(lastUpdateCursor));
      } else if (lastEventId !== null) {
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

    function replayInitialPage(page: SessionSnapshotPage): void {
      // Seed lastEventId from the page's event-log watermark. A present
      // watermark sets the cursor to 0 so the WebSocket connect uses
      // `fromId=0` — the DO replays every stored event, closing the gap when
      // SessionIngest materialization lags behind the event-log high-water
      // mark. A cursor that live events already advanced is never regressed.
      if (workspaceSession && page.updateCursor !== undefined) {
        lastUpdateCursor = Math.max(lastUpdateCursor, page.updateCursor);
      } else if (lastEventId === null && page.watermarkEventId != null) {
        lastEventId = 0;
      }
      // Exactly one page per connect may seed the manager: a reconnect
      // catch-up that lands first wins, and a slower initial retry must not
      // reset the older-pages cursor back to the newest page afterwards.
      if (!initialPageRecorded) {
        initialPageRecorded = true;
        config.onInitialPageLoaded?.(page);
      }
      const version =
        workspaceSession && page.updateCursor !== undefined
          ? { sourceId: config.sessionId, cursor: page.updateCursor }
          : undefined;
      const infoCursor = sessionInfoVersions.get(page.info.id);
      if (!version || infoCursor === undefined || version.cursor >= infoCursor) {
        if (version) sessionInfoVersions.set(page.info.id, version.cursor);
        replaySnapshotPage(sink, page, version);
      } else {
        replayStoredMessages(page.messages, event => sink.onChatEvent(event), version);
      }
    }

    /**
     * One snapshot read. Never rejects: a failed read is a value the caller
     * reports and retries, so it can never cost the live connection.
     */
    async function readSnapshot(): Promise<SnapshotRead> {
      if (workspaceSession) {
        try {
          const fetchPage = config.fetchCloudSnapshotPage;
          if (!fetchPage)
            throw new Error('Cloud Agent workspace sessions require fetchCloudSnapshotPage');
          const page = cloudSessionMessagesPageSchema.parse(await fetchPage(config.sessionId, {}));
          return page === null ? { kind: 'missing' } : { kind: 'page', page };
        } catch (error) {
          return { kind: 'rejected', error };
        }
      }
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
        if (!config.fetchSnapshot)
          throw new Error('Cloud Agent legacy sessions require fetchSnapshot');
        return {
          kind: 'page',
          page: snapshotPageFromSnapshot(await config.fetchSnapshot(config.kiloSessionId)),
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
     * Handle one settled snapshot read: replay a page, or report a transient
     * failure once per episode while the retry chain keeps running. Returns true
     * when the episode is over, false when the read is worth retrying. A
     * terminal typed failure ends the episode unreported: only the initial read
     * surfaces it, exactly as it did before the retry existed, so a reconnect
     * never raises the session error for history that cannot be loaded at all.
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
      if (read.kind === 'typed' && read.outcome.kind !== 'retryable_failure') return true;
      reportSnapshotFailure(
        read.kind === 'rejected'
          ? snapshotReadFailureMessage(read.error)
          : sessionSnapshotFailureMessage(read.outcome.kind),
        expectedGeneration
      );
      return false;
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
        SNAPSHOT_READ_BASE_DELAY_MS * 2 ** retry
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
      // A terminal typed history failure is reported here, once per open, and
      // still connects: the websocket remains useful for live events.
      if (read.kind === 'typed' && read.outcome.kind !== 'retryable_failure') {
        reportSnapshotFailure(sessionSnapshotFailureMessage(read.outcome.kind), expectedGeneration);
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
          if (workspaceSession && raw.cursor !== undefined) {
            lastUpdateCursor = Math.max(lastUpdateCursor, raw.cursor);
            if (raw.eventId > 0) {
              const previous = eventVersions.get(raw.eventId);
              if (previous !== undefined && raw.cursor <= previous) return;
              eventVersions.delete(raw.eventId);
              eventVersions.set(raw.eventId, raw.cursor);
              // Bootstrap ancillary rows need not be cursor-ordered; transcript row guards
              // reject stale payloads even after this recent-event cache evicts them.
              if (eventVersions.size > MAX_EVENT_VERSIONS) {
                const oldest = eventVersions.keys().next().value;
                if (oldest !== undefined) eventVersions.delete(oldest);
              }
            }
          }
          // Track high-water mark for reconnect fromId only. Do not filter
          // by eventId: the DO entity-upserts tool/message parts under a
          // stable row id and rebroadcasts that same (or older) id with a
          // newer payload. Dropping those left live tools stuck on empty input.
          // eventId 0 is a synthetic sentinel and never advances the cursor.
          if (
            !workspaceSession &&
            raw.eventId > 0 &&
            (lastEventId === null || raw.eventId > lastEventId)
          ) {
            lastEventId = raw.eventId;
          }

          const batch = sources.read(raw);
          for (const event of batch.events) deliverEvent(raw, event, batch.source.version);
        },
        onConnected: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          startReplay();
        },
        onReconnected: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          startReplay();
          if (workspaceSession) return;
          // With a replay cursor the socket itself re-delivers everything
          // missed while dead — replaying a (possibly stale) snapshot on top
          // would overwrite newer parts. Only fall back to the snapshot when
          // no cursor exists yet.
          if (lastEventId !== null) return;
          // Reconnect replays use the bounded page fetch (newest 50) to
          // avoid overwriting older messages the user has already loaded via
          // `loadOlderMessages`. The manager already has the cursor from
          // the initial connect, so `replayInitialPage` only hands this page to
          // the manager when no page seeded the session yet — a reconnect must
          // never reset the user's older-pages cursor back to the latest 50.
          cancelSnapshotRetry();
          void readSnapshot().then(read => {
            if (expectedGeneration !== lifecycleGeneration) return;
            if (!applySnapshotRead(read, replayInitialPage, expectedGeneration)) {
              scheduleSnapshotRetry(replayInitialPage, expectedGeneration, 0);
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
        eventVersions.clear();
        sessionInfoVersions.clear();
      },

      send: input => {
        if (!input.messageId) {
          // A Cloud Agent send without a client id cannot be replayed: the
          // server would admit a second turn for a retry of the same message.
          throw new Error('Cloud Agent sends require a client message id');
        }
        const { messageId } = input;
        return runMutation(() =>
          config.api.send({
            sessionId: config.sessionId,
            payload: normalizeCloudAgentPayload(input.payload),
            messageId,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          })
        );
      },
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
