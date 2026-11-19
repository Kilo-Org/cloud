/**
 * Cloud Agent transport — wraps createConnection to normalize raw wire events
 * and route them to separate chat/service sinks via the Transport interface.
 *
 * Snapshots seed the transcript; WebSocket replay closes the snapshot gap while
 * service-state notifications are batched until bootstrap completes.
 */
import type { ToolDisplayMode } from './tool-detail-marker';
import { createBackgroundActivityReader } from './background-activity';
import { setBounded } from './bounded-map';
import { createConnection, type Connection } from './cloud-agent-connection';
import type { ConnectionLifecycleHooks, WebSocketHeaders } from './base-connection';
import { isChatEvent, type NormalizedEvent } from './normalizer';
import { createConversationSourceReader } from './conversation-source';
import type { CloudAgentEvent } from './cloud-conversation-schemas';
import type { CloudSessionSnapshotPage } from './types';
import type { ServiceEvent } from './normalizer';
import {
  replaySnapshotPage,
  replayStoredMessages,
  SESSION_HISTORY_UNAVAILABLE_MESSAGE,
  sessionSnapshotFailureMessage,
  snapshotPageFromSnapshot,
} from './snapshot-page';
import {
  cloudMessageInfoSchema,
  cloudMessagePartSchema,
  cloudSessionMessagesPageSchema,
  customerBillingFailureSchema,
} from './schemas';
import type {
  CloudAgentSessionId,
  KiloSessionId,
  QueuedMessageSnapshot,
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
  if (payload.type === 'command') {
    if (payload.model && payload.model.providerID !== 'kilo') {
      throw new Error('Cloud Agent only supports Kilo models');
    }
    return {
      type: 'command',
      command: payload.command,
      arguments: payload.arguments,
      ...(payload.mode ? { mode: payload.mode } : {}),
      ...(payload.model ? { model: payload.model.modelID } : {}),
      ...(payload.variant ? { variant: payload.variant } : {}),
    };
  }
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
  /** An independently authorized read started while session metadata was loading. */
  initialSnapshotRead?: Promise<SnapshotRead> | undefined;
  /** Called after a successful initial bounded page read. */
  onInitialPageLoaded?: ((page: SessionSnapshotPage) => void) | undefined;
  websocketBaseUrl: string;
  onError?: ((message: string) => void) | undefined;
  lifecycleHooks?: ConnectionLifecycleHooks | undefined;
  websocketHeaders?: WebSocketHeaders | undefined;
  /**
   * `preview` asks historical replay for the same bounded tool projection as
   * history pages. Live events always carry complete data.
   */
  toolDisplay?: ToolDisplayMode | undefined;
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

async function readCloudSnapshotPage(
  fetchPage: NonNullable<CloudAgentTransportConfig['fetchCloudSnapshotPage']>,
  sessionId: CloudAgentSessionId
): Promise<SnapshotRead> {
  let payload: unknown;
  try {
    payload = await fetchPage(sessionId, {});
  } catch (error) {
    return { kind: 'rejected', error };
  }
  // A page that fails the schema is terminal: a retry replays the same
  // persisted page, and its validation text is not a user-facing message.
  // The schema's transform can also throw (a session-identity mismatch), and
  // safeParse does not convert a transform throw into a failure result.
  let parsed: { success: true; data: CloudSessionSnapshotPage | null } | { success: false };
  try {
    parsed = cloudSessionMessagesPageSchema.safeParse(payload);
  } catch {
    return { kind: 'typed', outcome: { kind: 'invalid_data' } };
  }
  if (!parsed.success) return { kind: 'typed', outcome: { kind: 'invalid_data' } };
  return parsed.data === null ? { kind: 'missing' } : { kind: 'page', page: parsed.data };
}

function snapshotReadFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return SESSION_HISTORY_UNAVAILABLE_MESSAGE;
}
const MAX_EVENT_VERSIONS = 2048;
const MAX_SESSION_INFO_VERSIONS = 1024;

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
    // Bumped whenever a snapshot catch-up is superseded (connect, disconnect,
    // reconnect, destroy). A read dispatched under an older epoch is dropped
    // when it settles, so it cannot replay a page over newer live state.
    let snapshotCatchUpEpoch = 0;
    let initialSnapshotRead = config.initialSnapshotRead;
    let backgroundEnabled = false;
    const readActivity = config.api.getBackgroundActivity;
    const background = readActivity
      ? createBackgroundActivityReader({
          sessionID: config.kiloSessionId,
          read: signal => readActivity({ sessionId: config.sessionId, signal }),
          publish: state => sink.onServiceEvent({ type: 'background.activity', state }),
        })
      : undefined;

    /**
     * Supersede the pending snapshot catch-up: clear the retry timer and
     * invalidate any read it already dispatched. Reconnect, connect,
     * disconnect, and destroy all cancel, so catch-up always restarts from the
     * newest connection's own cursor.
     */
    function cancelSnapshotRetry(): boolean {
      const wasScheduled = snapshotRetryTimer !== null;
      clearTimeout(snapshotRetryTimer ?? undefined);
      snapshotRetryTimer = null;
      snapshotFailureReported = false;
      // Invalidate catch-up reads dispatched earlier: they settle into a void
      // result instead of replaying a page over the new connection's state,
      // and a superseded failure raises no duplicate error report.
      snapshotCatchUpEpoch += 1;
      return wasScheduled;
    }
    let lastUpdateCursor = 0;
    const eventVersions = new Map<number, number>();
    const sessionInfoVersions = new Map<string, number>();

    function deliverEvent(
      raw: CloudAgentEvent,
      event: NormalizedEvent,
      sourceVersion: 'v1' | 'v2'
    ): void {
      if (event.type === 'background.invalidated') {
        background?.invalidate();
        return;
      }
      if (
        backgroundEnabled &&
        (event.type.startsWith('question.') ||
          event.type.startsWith('permission.') ||
          event.type === 'session.status')
      )
        background?.invalidate();
      if (event.type === 'cloud.status') {
        if (
          backgroundEnabled &&
          (event.cloudStatus.type === 'preparing' || event.cloudStatus.type === 'error')
        )
          background?.stop();
        else if (event.cloudStatus.type === 'ready' && backgroundEnabled) background?.start();
      }
      if (
        event.type === 'message.part.updated' &&
        event.part.type === 'tool' &&
        event.part.tool.startsWith('background_')
      )
        background?.invalidate();
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
          setBounded(sessionInfoVersions, event.info.id, raw.cursor, MAX_SESSION_INFO_VERSIONS);
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
      if (config.toolDisplay === 'preview') url.searchParams.set('toolDisplay', 'preview');
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

    /**
     * Emit the page's queued and failed turns through the service sink exactly
     * as the `connected` snapshot does, so a client that never reaches the
     * socket builds the same pending entries and synthetic rows. A page
     * snapshot carries no retry attempt count, so a failure that is not an
     * interrupt replays as a terminal execution failure.
     */
    function replayQueuedSnapshots(
      queuedMessages: readonly QueuedMessageSnapshot[] | undefined
    ): void {
      for (const queued of queuedMessages ?? []) {
        if (queued.completedAt !== undefined) {
          sink.onServiceEvent({ type: 'cloud.message.completed', messageId: queued.messageId });
          continue;
        }
        const failure = queued.terminalFailure;
        // A turn that is merely queued or already accepted carries no event of
        // its own: the stream reports it only as the active message.
        if (failure === undefined) continue;
        sink.onServiceEvent({
          type: 'cloud.message.queued',
          messageId: queued.messageId,
          content: queued.content,
          createdAt: queued.timestamp,
        });
        const billingFailure =
          failure.billingFailure === undefined
            ? undefined
            : customerBillingFailureSchema.safeParse(failure.billingFailure);
        sink.onServiceEvent({
          type: 'cloud.message.failed',
          messageId: queued.messageId,
          ...(failure.delivery === undefined ? {} : { delivery: failure.delivery }),
          ...(failure.accepted === undefined ? {} : { accepted: failure.accepted }),
          error: failure.error ?? 'Message delivery failed',
          reason:
            failure.status === 'interrupted' || failure.reason === 'interrupted'
              ? 'interrupted'
              : 'execution',
          ...(billingFailure?.success === true ? { billingFailure: billingFailure.data } : {}),
        });
      }
    }

    function replayInitialPage(page: SessionSnapshotPage): void {
      if (page.sourceVersion === 'v2') backgroundEnabled = true;
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
      // reset the older-pages cursor back to the newest page afterwards. The
      // replayed queued turns are current state, so only that page emits them.
      if (!initialPageRecorded) {
        initialPageRecorded = true;
        config.onInitialPageLoaded?.(page);
        replayQueuedSnapshots(page.queuedMessages);
      }
      sources.observeProjected(page.messages);
      const version =
        workspaceSession && page.updateCursor !== undefined
          ? { sourceId: config.sessionId, cursor: page.updateCursor }
          : undefined;
      const infoCursor = sessionInfoVersions.get(page.info.id);
      if (!version || infoCursor === undefined || version.cursor >= infoCursor) {
        if (version)
          setBounded(sessionInfoVersions, page.info.id, version.cursor, MAX_SESSION_INFO_VERSIONS);
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
        const fetchPage = config.fetchCloudSnapshotPage;
        if (!fetchPage) {
          return {
            kind: 'rejected',
            error: new Error('Cloud Agent workspace sessions require fetchCloudSnapshotPage'),
          };
        }
        return readCloudSnapshotPage(fetchPage, config.sessionId);
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
     * Record a superseded snapshot page without replaying its message rows.
     * A reconnect dropped the read that fetched this page, so its rows may be
     * older than the live replay already delivered — but the manager still
     * needs the page's metadata: seeding the first page sets the
     * older-messages cursor and emits the queued and failed turns, which
     * nothing else does for this connection.
     */
    function recordInitialPageOnly(page: SessionSnapshotPage): void {
      backgroundEnabled = backgroundEnabled || page.sourceVersion === 'v2';
      if (workspaceSession && page.updateCursor !== undefined) {
        lastUpdateCursor = Math.max(lastUpdateCursor, page.updateCursor);
      } else if (lastEventId === null && page.watermarkEventId != null) {
        lastEventId = 0;
      }
      if (!initialPageRecorded) {
        initialPageRecorded = true;
        config.onInitialPageLoaded?.(page);
        replayQueuedSnapshots(page.queuedMessages);
      }
    }

    /**
     * One best-effort page read for a reconnect whose cancel removed a still
     * scheduled catch-up. The reconnect reached only this helper or the
     * no-cursor fallback, so such a read always replays on a cursorless
     * connect; here it is recorded without replaying bounded rows over the
     * reconnect's live socket replay (which this connection owns), and a
     * failed read arms a fresh retry chain.
     */
    function dispatchRetryRead(expectedGeneration: number): void {
      const epoch = snapshotCatchUpEpoch;
      void readSnapshot().then(read => {
        if (expectedGeneration !== lifecycleGeneration) return;
        // A newer reconnect superseded this read: record, same as below.
        if (epoch !== snapshotCatchUpEpoch) {
          if (read.kind === 'page') recordInitialPageOnly(read.page);
          return;
        }
        if (!applySnapshotRead(read, recordInitialPageOnly, expectedGeneration)) {
          scheduleSnapshotRetry(recordInitialPageOnly, expectedGeneration, 0);
        }
      });
    }

    /**
     * Snapshot catch-up for the no-cursor reconnect fallback: read, replay,
     * and retry as usual. A read that a newer reconnect superseded is dropped
     * before it can replay rows.
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
          const epoch = snapshotCatchUpEpoch;
          void readSnapshot().then(read => {
            if (expectedGeneration !== lifecycleGeneration) return;
            // A cancel that raced this read (superseded catch-up) wins: the
            // page may predate the latest connection's live replay, so its
            // bounded rows must not be re-emitted on top of that state. The
            // manager still gets the page record — the first recorded page
            // seeds the older-messages cursor and the queued-turn rows —
            // but the message rows are skipped, and the chain ends because
            // the superseding connection owns catch-up.
            if (epoch !== snapshotCatchUpEpoch) {
              if (read.kind === 'page' && onPage === replayInitialPage) {
                recordInitialPageOnly(read.page);
              }
              return;
            }
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
      let ticketFailed = false;
      const firstRead = initialSnapshotRead ?? readSnapshot();
      initialSnapshotRead = undefined;
      const [ticket, read] = await Promise.all([
        Promise.resolve(config.getTicket(config.sessionId)).catch(error => {
          ticketFailed = true;
          throw error;
        }),
        firstRead.then(read => {
          // History is independently access-checked. Paint it without waiting for live auth.
          if (!ticketFailed && expectedGeneration === lifecycleGeneration && read.kind === 'page') {
            replayInitialPage(read.page);
          }
          return read;
        }),
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
      if (!applySnapshotRead(read, () => {}, expectedGeneration)) {
        scheduleSnapshotRetry(replayInitialPage, expectedGeneration, 0);
      }
      return { ticket };
    }

    function connectWebSocket(
      ticket: CloudAgentStreamTicketResult,
      expectedGeneration: number
    ): void {
      if (expectedGeneration !== lifecycleGeneration) return;

      const stoppedEvent: ServiceEvent = { type: 'stopped', reason: 'transport-disconnected' };
      const exhaustedEvent: ServiceEvent = {
        type: 'stopped',
        reason: 'transport-disconnected',
        exhausted: true,
      };
      // The base connection reports exhaustion on both edges. Only the first
      // `true` per connection escalates, so a repeated report never publishes
      // a second terminal stop.
      let exhaustionReported = false;

      const nextConnection = createConnection({
        websocketUrl: buildWebsocketUrl,
        ticket,
        lifecycleHooks: config.lifecycleHooks,
        websocketHeaders: config.websocketHeaders,
        onReconnectExhaustionChange: exhausted => {
          if (expectedGeneration !== lifecycleGeneration) return;
          if (!exhausted) {
            exhaustionReported = false;
            return;
          }
          if (exhaustionReported) return;
          exhaustionReported = true;
          sink.onServiceEvent(exhaustedEvent);
        },
        onEvent: raw => {
          if (expectedGeneration !== lifecycleGeneration || raw.sessionId !== config.sessionId) {
            return;
          }
          if (workspaceSession && raw.cursor !== undefined) {
            lastUpdateCursor = Math.max(lastUpdateCursor, raw.cursor);
            if (raw.eventId > 0) {
              const previous = eventVersions.get(raw.eventId);
              if (previous !== undefined && raw.cursor <= previous) return;
              // Bootstrap ancillary rows need not be cursor-ordered; transcript row guards
              // reject stale payloads even after this recent-event cache evicts them.
              setBounded(eventVersions, raw.eventId, raw.cursor, MAX_EVENT_VERSIONS);
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
          if (batch.source.version === 'v2' && !backgroundEnabled) {
            backgroundEnabled = true;
            background?.start();
          }
          for (const event of batch.events) deliverEvent(raw, event, batch.source.version);
        },
        onConnected: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          startReplay();
          if (backgroundEnabled) background?.start();
        },
        onReconnected: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          // A reconnect owns catch-up: the socket replays from its cursor
          // (fromId / afterCursor), or the no-cursor fallback below reads a
          // fresh page. A retry armed by the initial read must not replay a
          // snapshot page on top of that live state, and a catch-up read that
          // is already in flight is dropped by the epoch bump.
          const hadPendingCatchUp = cancelSnapshotRetry();
          startReplay();
          if (backgroundEnabled) background?.start();
          // The lost page seed applies to workspace sessions too, with the
          // same row-replay best-effort skip (dispatchRetryRead).
          const usesCursorOnlyReplay = workspaceSession || lastEventId !== null;
          if (usesCursorOnlyReplay) {
            if (hadPendingCatchUp) dispatchRetryRead(expectedGeneration);
            return;
          }
          // Reconnect replays use the bounded page fetch (newest 50) to
          // avoid overwriting older messages the user has already loaded via
          // `loadOlderMessages`. The manager already has the cursor from
          // the initial connect, so `replayInitialPage` only hands this page to
          // the manager when no page seeded the session yet — a reconnect must
          // never reset the user's older-pages cursor back to the latest 50.
          const epoch = snapshotCatchUpEpoch;
          void readSnapshot().then(read => {
            if (expectedGeneration !== lifecycleGeneration) return;
            // A newer reconnect superseded this read: record its page
            // without replaying bounded rows over the newer live replay.
            if (epoch !== snapshotCatchUpEpoch) {
              if (read.kind === 'page') recordInitialPageOnly(read.page);
              return;
            }
            if (!applySnapshotRead(read, replayInitialPage, expectedGeneration)) {
              scheduleSnapshotRetry(replayInitialPage, expectedGeneration, 0);
            }
          });
        },
        onDisconnected: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          if (backgroundEnabled) background?.stop();
          if (!replaying) return;
          sink.onServiceEvent(stoppedEvent);
          cancelReplay();
          stoppedReceived = true;
        },
        onUnexpectedDisconnect: () => {
          if (expectedGeneration !== lifecycleGeneration) return;
          if (backgroundEnabled) background?.stop();
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
        if (backgroundEnabled) background?.stop();
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
        if (backgroundEnabled) background?.stop();
        cancelReplay();
        cancelSnapshotRetry();
        lifecycleGeneration += 1;
        closeConnection('disconnect');
      },

      destroy() {
        if (backgroundEnabled) background?.stop();
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
      observeProjected: messages => sources.observeProjected(messages),
      retryBackgroundActivity: () => background?.retry(),
    };
  };
}

export { createCloudAgentTransport, readCloudSnapshotPage };
export type { CloudAgentTransportConfig, SnapshotRead };
