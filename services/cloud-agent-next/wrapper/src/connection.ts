/**
 * Connection management for the long-running wrapper.
 *
 * Handles:
 * - Ingest WebSocket connection (for sending events to DO)
 * - SSE consumer (for receiving events from kilo server)
 *
 * Connections are opened on-demand when the wrapper transitions from IDLE to ACTIVE,
 * and closed when transitioning back to IDLE (after drain period).
 */

import type { WrapperState } from './state.js';
import type { IngestEvent, WrapperCommand } from '../../src/shared/protocol.js';
import { trimPayload } from '../../src/shared/trim-payload.js';
import { logToFile } from './utils.js';
import type { KiloEvent, WrapperKiloClient } from './kilo-api.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCodeReviewJob(state: WrapperState): boolean {
  return state.currentSession?.platform === 'code-review';
}

function gateResultFromProperties(
  properties: Record<string, unknown>
): 'pass' | 'fail' | undefined {
  const gateResult = properties.gateResult;
  return gateResult === 'pass' || gateResult === 'fail' ? gateResult : undefined;
}

function statusTypeFromProperties(properties: Record<string, unknown>): string | undefined {
  const status = properties.status;
  return isRecord(status) && typeof status.type === 'string' ? status.type : undefined;
}

function isInteractiveStatusType(statusType: string | undefined): boolean {
  return statusType === 'question' || statusType === 'permission';
}

function permissionCategoryFromProperties(properties: Record<string, unknown>): string {
  const permission = properties.permission;
  if (isRecord(permission)) {
    const type = permission.type;
    if (typeof type === 'string') return type;
    const tool = permission.tool;
    if (typeof tool === 'string') return tool;
  }

  if (typeof permission !== 'string') return 'unknown';
  const normalized = permission.toLowerCase();
  if (normalized.includes('glab')) return 'bash:glab';
  if (normalized === 'gh' || normalized.includes('gh ')) return 'bash:gh';
  if (normalized.includes('git ')) return 'bash:git';
  if (normalized.includes('bash')) return 'bash';
  if (normalized.includes('edit')) return 'edit';
  if (normalized.includes('web')) return 'web';
  return 'unknown';
}

function getActivitySessionID(
  eventType: string,
  properties: Record<string, unknown>
): string | undefined {
  if (eventType === 'message.updated') {
    const info = properties.info;
    return isRecord(info) && typeof info.sessionID === 'string' ? info.sessionID : undefined;
  }

  if (eventType === 'message.part.updated') {
    const part = properties.part;
    return isRecord(part) && typeof part.sessionID === 'string' ? part.sessionID : undefined;
  }

  return typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
}

function isRootSessionActivity(
  eventType: string,
  properties: Record<string, unknown>,
  rootSessionID: string | undefined
): boolean {
  if (!rootSessionID || eventType === 'session.idle') return false;
  if (eventType === 'session.status' && statusTypeFromProperties(properties) === 'idle') {
    return false;
  }

  return getActivitySessionID(eventType, properties) === rootSessionID;
}

export const CODE_REVIEW_PERMISSION_REJECTION_MESSAGE =
  'Permission rejected for code-review non-interactive mode. Continue using another read-only, non-interactive method if available.';

function rejectCodeReviewQuestion(
  questionId: string | undefined,
  kiloClient: WrapperKiloClient
): void {
  if (!questionId) return;
  kiloClient.rejectQuestion(questionId).catch(err => {
    logToFile(
      `failed to reject code-review question ${questionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}

function rejectCodeReviewPermission(
  permissionId: string | undefined,
  properties: Record<string, unknown>,
  state: WrapperState,
  kiloClient: WrapperKiloClient
): void {
  if (!permissionId) return;
  logToFile(
    JSON.stringify({
      message: 'code_review_permission_rejected',
      agentSessionId: state.currentSession?.agentSessionId,
      kiloSessionId: state.currentSession?.kiloSessionId,
      permissionCategory: permissionCategoryFromProperties(properties),
      policy: 'code-review-read-only',
      reason: 'non-interactive-unapproved',
    })
  );
  kiloClient
    .answerPermission(permissionId, 'reject', CODE_REVIEW_PERMISSION_REJECTION_MESSAGE)
    .catch(err => {
      logToFile(
        `failed to reject code-review permission ${permissionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
}

export function trimIngestEvent(event: IngestEvent): IngestEvent {
  return {
    ...event,
    data: trimPayload(event.streamEventType, event.data),
  };
}

/**
 * Type guard for session.idle events.
 * Kilo server sends: {type: "session.idle", properties: {sessionID: "..."}}
 * After mapping: {type: "session.idle", properties: {sessionID: "..."}, event: "session.idle"}
 */
export function isSessionIdleEvent(
  data: unknown
): data is { event: 'session.idle'; properties: { sessionID: string } } {
  if (!isRecord(data)) return false;
  if (data.event !== 'session.idle') return false;
  const props = data.properties;
  return isRecord(props) && typeof props.sessionID === 'string';
}

/**
 * Type guard for message.updated events where the assistant message is
 * terminal (has time.completed or an error) and has a resolvable parentID.
 * Used by the wrapper to detect per-message completion in the new-path
 * keep-warm model.
 */
export function isAssistantMessageCompleted(data: unknown): data is {
  event: 'message.updated';
  properties: { info: { role: string; parentID: string; time?: { completed?: number } } };
} {
  if (!isRecord(data)) return false;
  if (data.event !== 'message.updated') return false;
  const info = isRecord(data.properties) ? data.properties.info : undefined;
  if (!isRecord(info)) return false;
  if (info.role !== 'assistant') return false;
  if (typeof info.parentID !== 'string') return false;
  const time = isRecord(info.time) ? info.time : undefined;
  const isCompleted = time !== undefined && typeof time.completed === 'number';
  const hasError = info.error !== undefined && info.error !== null;
  return isCompleted || hasError;
}

/**
 * Extracts the parentID of a completed assistant message from a
 * message.updated event. Returns undefined if the event is not a
 * terminal assistant message update.
 */
export function getCompletedAssistantParentID(data: unknown): string | undefined {
  if (!isAssistantMessageCompleted(data)) return undefined;
  return (data.properties.info as { parentID: string }).parentID;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionConfig = {
  kiloClient: WrapperKiloClient;
};

export type ConnectionCallbacks = {
  /** Called when a completion event is detected for a message */
  onMessageComplete: (messageId: string) => void;
  /** Called when a terminal error is detected */
  onTerminalError: (reason: string) => void;
  /** Called when a command is received from DO */
  onCommand: (cmd: WrapperCommand) => void;
  /** Called when the connection unexpectedly closes */
  onDisconnect: (reason: string) => void;
  /** Called on any completion event to signal post-processing waiters */
  onCompletionSignal: () => void;
  /** Called when the root session reports idle. */
  onSessionIdle?: () => void;
  /** Called when a non-idle event belongs to the root Kilo session. */
  onRootSessionActivity?: () => void;
  /** Called on any SSE event to reset transport health timer */
  onSseEvent?: () => void;
  /** Called when the ingest WS starts reconnecting */
  onReconnecting?: (attempt: number) => void;
  /** Called when the ingest WS successfully reconnects */
  onReconnected?: () => void;
};

type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> } | string | string[]
) => WebSocket;

export type IngestConnectionFailureReason = 'websocket_error' | 'closed_before_open' | 'timeout';

export type IngestConnectionFailureDetails = {
  reason: IngestConnectionFailureReason;
  wsUrl: string;
  closeCode?: number;
  closeReason?: string;
};

const INGEST_CONNECTION_FAILURE_HINTS: Record<IngestConnectionFailureReason, string> = {
  websocket_error:
    'WebSocket error before open; Bun does not expose the HTTP status. If the Worker logs no /ingest request, check WORKER_URL and sandbox-to-host networking; if it logs a 4xx, inspect the DO rejection reason.',
  closed_before_open:
    'WebSocket closed before open. If the Worker logs a 4xx for /ingest, inspect the DO rejection reason; if it logs no request, check WORKER_URL and sandbox-to-host networking.',
  timeout:
    'Timed out before open; check WORKER_URL and whether the sandbox can reach the local cloud-agent Worker.',
};

export function buildIngestConnectionFailureMessage(
  details: IngestConnectionFailureDetails
): string {
  const closeDetails =
    details.closeCode !== undefined
      ? ` closeCode=${details.closeCode} closeReason=${details.closeReason || '(none)'}`
      : '';
  return `Failed to connect to ingest: ${details.wsUrl} (${INGEST_CONNECTION_FAILURE_HINTS[details.reason]}${closeDetails})`;
}

/** Maximum number of reconnection attempts before giving up.
 *  3 attempts ≈ 7s total (1+2+4), fitting within the DO's 10s grace period. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** Base delay for exponential backoff (1 second) */
const RECONNECT_BASE_DELAY_MS = 1_000;
/** Maximum time to wait for the SDK SSE `/event` handshake before aborting.
 *  The wrapper talks to kilo on loopback, so handshakes typically complete in
 *  <5ms; a 5s budget covers kilo startup hiccups without blocking `open()` on
 *  a silently stuck HTTP stream. */
const SUBSCRIBE_HANDSHAKE_TIMEOUT_MS = 5_000;
const INGEST_INITIAL_CONNECT_TIMEOUT_MS = 10_000;

function buildIngestWebSocketUrl(session: NonNullable<WrapperState['currentSession']>): string {
  const url = new URL(session.ingestUrl);
  if (session.wrapperRunId) {
    url.searchParams.set('wrapperRunId', session.wrapperRunId);
  }
  url.searchParams.set('kiloSessionId', session.kiloSessionId);
  url.searchParams.set('sessionId', session.agentSessionId ?? '');
  if (session.wrapperGeneration !== undefined) {
    url.searchParams.set('wrapperGeneration', String(session.wrapperGeneration));
  }
  if (session.wrapperConnectionId) {
    url.searchParams.set('wrapperConnectionId', session.wrapperConnectionId);
  }
  return url.toString();
}

export type IngestProgressChannel = {
  close(): void;
};

export async function openIngestProgressChannel(
  state: WrapperState
): Promise<IngestProgressChannel> {
  const session = state.currentSession;
  if (!session) {
    throw new Error('Cannot open ingest progress channel: no session context');
  }

  const wsUrl = buildIngestWebSocketUrl(session);
  logToFile(`ingest progress WS connecting to: ${wsUrl}`);

  return new Promise<IngestProgressChannel>((resolve, reject) => {
    let settled = false;
    let active = false;
    let initialConnectTimer: ReturnType<typeof setTimeout> | undefined;

    const clearInitialConnectTimer = () => {
      if (initialConnectTimer !== undefined) {
        clearTimeout(initialConnectTimer);
        initialConnectTimer = undefined;
      }
    };

    const rejectInitialConnect = (details: IngestConnectionFailureDetails) => {
      if (settled) return;
      settled = true;
      clearInitialConnectTimer();
      reject(new Error(buildIngestConnectionFailureMessage(details)));
    };

    const WebSocketWithHeaders = WebSocket as unknown as WebSocketCtor;
    const ws = new WebSocketWithHeaders(wsUrl, {
      headers: {
        Authorization: `Bearer ${session.workerAuthToken}`,
      },
    });

    const sendProgressEvent = (event: IngestEvent): void => {
      if (active && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    };

    const close = () => {
      active = false;
      state.setSendToIngestFn(null);
      try {
        ws.close();
      } catch {
        // Ignore close errors.
      }
    };

    ws.onopen = () => {
      if (settled) {
        try {
          ws.close();
        } catch {
          // Ignore close errors.
        }
        return;
      }

      logToFile(`ingest progress WS connected to: ${wsUrl}`);
      settled = true;
      active = true;
      clearInitialConnectTimer();
      state.setSendToIngestFn(sendProgressEvent);
      resolve({ close });
    };

    ws.onclose = (event: CloseEvent) => {
      logToFile(
        `ingest progress WS closed: code=${event.code} reason=${event.reason || '(none)'} url=${wsUrl}`
      );
      if (!settled) {
        rejectInitialConnect({
          reason: 'closed_before_open',
          wsUrl,
          closeCode: event.code,
          closeReason: event.reason,
        });
        return;
      }
      if (active) {
        active = false;
        state.setSendToIngestFn(null);
      }
    };

    ws.onerror = () => {
      logToFile(`ingest progress WS error connecting to: ${wsUrl}`);
      if (!settled) {
        rejectInitialConnect({ reason: 'websocket_error', wsUrl });
      }
    };

    initialConnectTimer = setTimeout(() => {
      if (!settled) {
        logToFile(`ingest progress WS connection timed out: ${wsUrl}`);
        rejectInitialConnect({ reason: 'timeout', wsUrl });
        try {
          ws.close();
        } catch {
          // Ignore close errors.
        }
      }
    }, INGEST_INITIAL_CONNECT_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------------------
// Connection Manager
// ---------------------------------------------------------------------------

export type ConnectionManager = {
  /** Open ingest WS and SSE consumer. Resolves when both are connected. */
  open: () => Promise<void>;
  /** Close both connections gracefully. */
  close: () => Promise<void>;
  /** Check if currently connected. */
  isConnected: () => boolean;
  /** Whether the ingest WS is currently attempting to reconnect */
  isReconnecting: () => boolean;
  /** Abort and restart the SDK event subscription (does not tear down ingest WS). */
  reconnectEventSubscription: () => void;
  /** Fetch fresh kilo server state and send it as regular kilocode events to the DO. Best-effort. */
  sendKiloSnapshot: () => Promise<void>;
};

/**
 * Create a connection manager that handles ingest WS and SSE consumer.
 *
 * The connections are stored in WrapperState for reference, but actual
 * management (open/close) happens here.
 */
export function createConnectionManager(
  state: WrapperState,
  config: ConnectionConfig,
  callbacks: ConnectionCallbacks
): ConnectionManager {
  let ingestWs: WebSocket | null = null;
  let eventSubscriptionActive = false;
  let eventSubscriptionGeneration = 0;
  let eventSubscriptionAbort: AbortController | null = null;

  let closedByUs = false;
  let reconnecting = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  // Event buffer for disconnection periods
  const MAX_BUFFER_SIZE = 1000;
  const eventBuffer: IngestEvent[] = [];
  let bufferOverflowed = false;

  /**
   * Send an event to the ingest WebSocket.
   * Buffers events if disconnected.
   */
  function sendToIngest(event: IngestEvent): void {
    if (ingestWs && ingestWs.readyState === WebSocket.OPEN) {
      ingestWs.send(JSON.stringify(event));
    } else {
      // Buffer events while disconnected
      if (eventBuffer.length < MAX_BUFFER_SIZE) {
        eventBuffer.push(event);
      } else {
        bufferOverflowed = true;
      }
    }
  }

  /**
   * Flush buffered events after reconnection.
   */
  function clearBuffer(): void {
    eventBuffer.length = 0;
    bufferOverflowed = false;
  }

  function flushBuffer(): void {
    if (!ingestWs || ingestWs.readyState !== WebSocket.OPEN) return;

    // Send resume marker so DO knows we may have lost events
    if (eventBuffer.length > 0 || bufferOverflowed) {
      ingestWs.send(
        JSON.stringify({
          streamEventType: 'wrapper_resumed',
          timestamp: new Date().toISOString(),
          data: { bufferedEvents: eventBuffer.length, eventsLost: bufferOverflowed },
        })
      );
    }

    // Flush buffer
    for (const event of eventBuffer) {
      ingestWs.send(JSON.stringify(event));
    }
    clearBuffer();
  }

  async function resumeNetworkWait(requestID: string): Promise<void> {
    try {
      await config.kiloClient.resumeNetworkWait(requestID);
      logToFile(`resumed network wait ${requestID}`);
    } catch (err) {
      logToFile(
        `failed to resume network wait ${requestID}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function resumeRestoredNetworkWaits(): Promise<void> {
    const kiloSessionId = state.currentSession?.kiloSessionId;
    if (!kiloSessionId) {
      logToFile('skipping restored network resume: no kiloSessionId');
      return;
    }

    const networkWaits = await config.kiloClient.getNetworkWaits();
    await Promise.all(
      networkWaits
        .filter(wait => wait.sessionID === kiloSessionId && wait.restored)
        .map(wait => resumeNetworkWait(wait.id))
    );
  }

  /**
   * Fetch current kilo server state and send it as regular kilocode events to the DO.
   * Called after ingest WS opens (initial connect and reconnect).
   * Best-effort: failures are logged but don't block the connection.
   */
  async function sendKiloSnapshot(): Promise<void> {
    try {
      const kiloSessionId = state.currentSession?.kiloSessionId;
      if (!kiloSessionId) {
        logToFile('skipping kilo snapshot: no kiloSessionId');
        return;
      }

      const [statuses, questions, permissions, networkWaits] = await Promise.all([
        config.kiloClient.getSessionStatuses(),
        config.kiloClient.getQuestions(),
        config.kiloClient.getPermissions(),
        config.kiloClient.getNetworkWaits(),
      ]);

      const statusEntry = statuses[kiloSessionId];
      const sessionStatus = (statusEntry ?? { type: 'idle' }) as {
        type: string;
        [key: string]: unknown;
      };

      const pendingQuestion = questions.find(q => q.sessionID === kiloSessionId);
      const pendingPermission = permissions.find(p => p.sessionID === kiloSessionId);
      const pendingNetworkWaits = networkWaits.filter(wait => wait.sessionID === kiloSessionId);
      const codeReviewJob = isCodeReviewJob(state);
      const skipStatusForCodeReview = codeReviewJob && isInteractiveStatusType(sessionStatus.type);

      // Send session status as a regular kilocode event
      if (!skipStatusForCodeReview) {
        const statusProperties = { sessionID: kiloSessionId, status: sessionStatus };
        sendToIngest({
          streamEventType: 'kilocode',
          data: {
            ...statusProperties,
            event: 'session.status',
            type: 'session.status',
            properties: statusProperties,
          },
          timestamp: new Date().toISOString(),
        });
      }

      // Replay pending questions/permissions as regular events
      // (same format as real-time delivery - matches CLI behavior)
      if (pendingQuestion && !codeReviewJob) {
        sendToIngest({
          streamEventType: 'kilocode',
          data: {
            event: 'question.asked',
            type: 'question.asked',
            properties: pendingQuestion,
          },
          timestamp: new Date().toISOString(),
        });
      }
      if (pendingPermission && !codeReviewJob) {
        sendToIngest({
          streamEventType: 'kilocode',
          data: {
            event: 'permission.asked',
            type: 'permission.asked',
            properties: pendingPermission,
          },
          timestamp: new Date().toISOString(),
        });
      }
      for (const wait of pendingNetworkWaits) {
        if (wait.restored) continue;
        sendToIngest({
          streamEventType: 'kilocode',
          data: {
            event: 'session.network.asked',
            type: 'session.network.asked',
            properties: wait,
          },
          timestamp: new Date().toISOString(),
        });
      }

      logToFile(
        `kilo state sent: status=${sessionStatus.type}${skipStatusForCodeReview ? ' (suppressed)' : ''}, question=${pendingQuestion?.id ?? 'none'}${codeReviewJob && pendingQuestion ? ' (suppressed)' : ''}, permission=${pendingPermission?.id ?? 'none'}${codeReviewJob && pendingPermission ? ' (suppressed)' : ''}, networkWaits=${pendingNetworkWaits.length}`
      );
    } catch (err) {
      logToFile(
        `failed to send kilo snapshot: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Fetch the kilo slash-command catalog and send it to the DO as a
   * `commands.available` event. Called after the ingest WS opens (initial
   * connect and reconnect) so the DO's cache is always fresh for clients.
   * Best-effort: failures are logged but don't block the connection.
   */
  async function sendCommandsAvailable(): Promise<void> {
    try {
      const commands = await config.kiloClient.listCommands();
      sendToIngest({
        streamEventType: 'commands.available',
        data: { commands },
        timestamp: new Date().toISOString(),
      });
      logToFile(`commands.available sent: count=${commands.length}`);
    } catch (err) {
      logToFile(
        `failed to send commands.available: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Open the ingest WebSocket connection.
   * @param expectedGeneration If provided, the connection is only accepted when
   *   `generation` still matches. This prevents a stale reconnect from assigning
   *   `ingestWs` and flushing buffered events after `close()` was called.
   */
  async function openIngestWs(expectedGeneration?: number): Promise<void> {
    const session = state.currentSession;
    if (!session) {
      throw new Error('Cannot open ingest WS: no session context');
    }

    const wsUrl = buildIngestWebSocketUrl(session);
    logToFile(`ingest WS connecting to: ${wsUrl}`);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let initialConnectTimer: ReturnType<typeof setTimeout> | undefined;

      const clearInitialConnectTimer = () => {
        if (initialConnectTimer !== undefined) {
          clearTimeout(initialConnectTimer);
          initialConnectTimer = undefined;
        }
      };

      const rejectInitialConnect = (details: IngestConnectionFailureDetails) => {
        if (settled) return;
        settled = true;
        clearInitialConnectTimer();
        reject(new Error(buildIngestConnectionFailureMessage(details)));
      };

      const resolveInitialConnect = () => {
        if (settled) return;
        settled = true;
        clearInitialConnectTimer();
        resolve();
      };

      // Bun's WebSocket supports headers parameter
      const WebSocketWithHeaders = WebSocket as unknown as WebSocketCtor;

      const ws = new WebSocketWithHeaders(wsUrl, {
        headers: {
          Authorization: `Bearer ${session.workerAuthToken}`,
        },
      });

      ws.onopen = () => {
        if (settled) {
          logToFile(`ingest WS opened after initial connection was already settled: ${wsUrl}`);
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }

        logToFile(`ingest WS connected to: ${wsUrl}`);
        // Guard against stale reconnect: if close() was called while we were
        // connecting, generation will have advanced and we must not adopt
        // this socket or flush buffered events through it.
        if (expectedGeneration !== undefined && expectedGeneration !== generation) {
          logToFile('stale reconnect detected in onopen — discarding socket');
          settled = true;
          clearInitialConnectTimer();
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('Stale reconnect'));
          return;
        }
        ingestWs = ws;
        flushBuffer();
        resolveInitialConnect();
      };

      ws.onclose = (event: CloseEvent) => {
        logToFile(
          `ingest WS closed: code=${event.code} reason=${event.reason || '(none)'} url=${wsUrl}`
        );
        if (!settled) {
          rejectInitialConnect({
            reason: 'closed_before_open',
            wsUrl,
            closeCode: event.code,
            closeReason: event.reason,
          });
          return;
        }
        if (ingestWs !== ws) return; // Stale socket — ignore

        ingestWs = null;

        if (closedByUs) {
          // Expected close (during drain/shutdown) — don't reconnect
          closedByUs = false;
          return;
        }

        // Unexpected close — attempt reconnection
        logToFile('ingest WS closed unexpectedly — starting reconnection');
        attemptReconnect();
      };

      ws.onerror = () => {
        logToFile(`ingest WS error connecting to: ${wsUrl}`);
        if (!settled) {
          rejectInitialConnect({ reason: 'websocket_error', wsUrl });
        }
      };

      ws.onmessage = event => {
        try {
          const cmd = JSON.parse(String(event.data)) as WrapperCommand;
          callbacks.onCommand(cmd);
        } catch {
          // Ignore parse errors
        }
      };

      // Timeout for initial connection
      initialConnectTimer = setTimeout(() => {
        if (!settled) {
          logToFile(`ingest WS connection timed out: ${wsUrl}`);
          rejectInitialConnect({ reason: 'timeout', wsUrl });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      }, INGEST_INITIAL_CONNECT_TIMEOUT_MS);
    });
  }

  /**
   * Check if an event represents a terminal error (payment/billing/quota/model resolution).
   */
  function isTerminalError(eventType: string, properties: Record<string, unknown>): boolean {
    if (eventType === 'payment_required' || eventType === 'insufficient_funds') {
      return true;
    }
    const error = properties.error;
    if (error) {
      const errorStr = typeof error === 'string' ? error : JSON.stringify(error);
      const normalizedError = errorStr.toLowerCase();
      if (
        normalizedError.includes('payment') ||
        normalizedError.includes('credit') ||
        normalizedError.includes('balance') ||
        normalizedError.includes('quota') ||
        (eventType === 'session.error' && normalizedError.includes('model not found'))
      ) {
        return true;
      }
    }
    return false;
  }

  function getTerminalErrorText(eventType: string, properties: Record<string, unknown>): string {
    const error = properties.error;
    if (typeof error === 'string') {
      return error;
    }

    if (isRecord(error)) {
      if (typeof error.message === 'string') {
        return error.message;
      }

      const data = error.data;
      if (isRecord(data) && typeof data.message === 'string') {
        return data.message;
      }

      return JSON.stringify(error);
    }

    return `Insufficient credits: ${eventType}`;
  }

  function maybeResumeNetworkWait(eventType: string, properties: Record<string, unknown>): void {
    if (eventType !== 'session.network.restored') return;

    const currentSessionId = state.currentSession?.kiloSessionId;
    const sessionID = typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
    if (!currentSessionId || sessionID !== currentSessionId) return;

    const requestID = typeof properties.requestID === 'string' ? properties.requestID : undefined;
    if (!requestID) {
      logToFile('session.network.restored without requestID — ignoring');
      return;
    }

    // Keep forwarding the restored event to ingest; this only unblocks the local Kilo wait.
    void resumeNetworkWait(requestID);
  }

  /**
   * Attach an SDK event subscription: perform the HTTP handshake and, on
   * success, launch the background stream consumer.
   *
   * Resolves only after `subscribeEvents` returns and the returned stream is
   * being consumed — i.e. subsequent events from kilo will flow into the
   * wrapper. Rejects if the handshake fails or returns no stream, so
   * `open()` can propagate the failure to its caller.
   *
   * If a newer attach starts while this one is mid-handshake, the newer
   * attach aborts this attach's controller and takes ownership of state;
   * this attach silently returns in that case.
   */
  async function attachEventSubscription(): Promise<void> {
    // Abort the previous subscription's HTTP stream (if any) before starting
    // a new one.  This ensures the old `for await` loop unblocks immediately
    // instead of lingering until the next server-sent event arrives.
    eventSubscriptionAbort?.abort();

    const myGeneration = ++eventSubscriptionGeneration;
    const abortController = new AbortController();
    eventSubscriptionAbort = abortController;
    // Publish connection references before awaiting the handshake so
    // DO-initiated commands arriving on the ingest WS during the handshake
    // window can still send events through the ingest socket. This matches
    // the pre-split behavior. `eventSubscriptionActive` does NOT flip yet —
    // `isConnected()` must stay false until the SSE stream is live.
    if (ingestWs) {
      state.setConnections(ingestWs, abortController);
      state.setSendToIngestFn(sendToIngest);
    }

    // Cap the handshake on a stuck kilo server. Firing the abort on timeout
    // propagates to the underlying fetch, so subscribeEvents() rejects and
    // open() can roll back cleanly instead of hanging. The timer is cleared
    // either on success or on any rejection below.
    const handshakeTimeoutError = new Error(
      `SSE subscribe handshake timed out after ${SUBSCRIBE_HANDSHAKE_TIMEOUT_MS}ms`
    );
    const handshakeTimer = setTimeout(() => {
      abortController.abort(handshakeTimeoutError);
    }, SUBSCRIBE_HANDSHAKE_TIMEOUT_MS);

    let result: Awaited<ReturnType<WrapperKiloClient['subscribeEvents']>>;
    try {
      result = await config.kiloClient.subscribeEvents({
        signal: abortController.signal,
      });
    } catch (err) {
      clearTimeout(handshakeTimer);
      // Superseded by a newer attach — silently yield to it.
      if (myGeneration !== eventSubscriptionGeneration) return;
      // If our own timeout fired, surface the timeout message rather than the
      // generic AbortError the SDK throws.
      if (abortController.signal.reason === handshakeTimeoutError) {
        throw handshakeTimeoutError;
      }
      throw err;
    }
    clearTimeout(handshakeTimer);

    // Superseded by a newer attach while we were awaiting — don't touch
    // shared state; the newer attach owns it now.
    if (myGeneration !== eventSubscriptionGeneration) return;

    if (!result.stream) {
      logToFile('No event stream returned from SDK');
      callbacks.onDisconnect('No event stream from SDK');
      throw new Error('No event stream from SDK');
    }

    logToFile('SDK event subscription started');

    // Handshake succeeded — SSE stream is live, `isConnected()` may now
    // return true. Start the background consumer.
    eventSubscriptionActive = true;
    consumeEventStream(myGeneration, abortController, result.stream);
  }

  /**
   * Background consumer for an attached SDK event stream. Runs until the
   * stream ends, the abort controller fires, or a newer subscription
   * supersedes this one.
   */
  function consumeEventStream(
    myGeneration: number,
    abortController: AbortController,
    stream: AsyncIterable<KiloEvent>
  ): void {
    void (async () => {
      try {
        for await (const event of stream) {
          if (abortController.signal.aborted || myGeneration !== eventSubscriptionGeneration) break;

          // eventType is `string` so we can match untyped events like server.heartbeat
          const eventType: string = event.type ?? '';
          const properties: Record<string, unknown> = isRecord(event.properties)
            ? event.properties
            : {};
          const gateResult = gateResultFromProperties(properties);
          if (gateResult !== undefined) {
            state.observeGateResult(gateResult);
          }

          // Track activity
          state.updateActivity();

          if (eventType === 'server.connected') {
            logToFile('SDK event subscription connected');
            callbacks.onSseEvent?.();
            continue;
          }

          // Forward kilo's heartbeat as ingest heartbeat (replaces wrapper's custom heartbeat)
          if (eventType === 'server.heartbeat') {
            const session = state.currentSession;
            if (session) {
              sendToIngest({
                streamEventType: 'heartbeat',
                data: { kiloSessionId: session.kiloSessionId },
                timestamp: new Date().toISOString(),
              });
            }
            callbacks.onSseEvent?.();
            continue;
          }

          if (isRootSessionActivity(eventType, properties, state.currentSession?.kiloSessionId)) {
            callbacks.onRootSessionActivity?.();
          }

          // Auto-approve permission requests so the kilo server never stalls
          // waiting for a human response that will never come.
          if (eventType === 'permission.asked') {
            const permId = typeof properties.id === 'string' ? properties.id : undefined;
            if (isCodeReviewJob(state)) {
              rejectCodeReviewPermission(permId, properties, state, config.kiloClient);
              callbacks.onSseEvent?.();
              continue;
            }

            if (permId) {
              logToFile(`auto-approving permission ${permId} (${String(properties.permission)})`);
              config.kiloClient.answerPermission(permId, 'always').catch(err => {
                logToFile(
                  `failed to auto-approve permission ${permId}: ${err instanceof Error ? err.message : String(err)}`
                );
              });
            }
            callbacks.onSseEvent?.();
            continue;
          }

          if (isCodeReviewJob(state)) {
            if (eventType === 'question.asked') {
              const questionId = typeof properties.id === 'string' ? properties.id : undefined;
              rejectCodeReviewQuestion(questionId, config.kiloClient);
              callbacks.onSseEvent?.();
              continue;
            }

            if (
              eventType === 'session.status' &&
              isInteractiveStatusType(statusTypeFromProperties(properties))
            ) {
              callbacks.onSseEvent?.();
              continue;
            }
          }

          maybeResumeNetworkWait(eventType, properties);

          // Build and forward ingest event
          const untrimmedIngestEvent: IngestEvent = {
            streamEventType: 'kilocode',
            data: { ...properties, event: eventType, type: eventType, properties },
            timestamp: new Date().toISOString(),
          };

          const ingestEvent = trimIngestEvent(untrimmedIngestEvent);
          sendToIngest(ingestEvent);
          callbacks.onSseEvent?.();

          // Track the last root-session assistant message ID for autocommit association
          if (eventType === 'message.updated') {
            const messageInfo = properties.info;
            if (
              isRecord(messageInfo) &&
              messageInfo.role === 'assistant' &&
              typeof messageInfo.id === 'string'
            ) {
              const msgSessionId =
                typeof messageInfo.sessionID === 'string' ? messageInfo.sessionID : undefined;
              const currentSessionId = state.currentSession?.kiloSessionId;
              if (!currentSessionId || msgSessionId === currentSessionId) {
                state.setLastAssistantMessageId(messageInfo.id);
              }
            }

            // Detect terminal assistant messages for per-message completion in
            // the new-path keep-warm model.
            const data = { event: eventType as 'message.updated', properties };
            const parentID = getCompletedAssistantParentID(data);
            if (parentID) {
              callbacks.onMessageComplete(parentID);
              callbacks.onCompletionSignal();
            }
          }

          // Terminal error detection
          if (isTerminalError(eventType, properties)) {
            callbacks.onTerminalError(getTerminalErrorText(eventType, properties));
            return;
          }

          // session.idle is the primary completion signal - it means the assistant finished
          // and the session is waiting for the next user input.
          // Only the root session's idle event should trigger completion — child sessions
          // (subagents) also emit session.idle, which we must ignore.
          if (eventType === 'session.idle') {
            const sessionID =
              typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
            if (!sessionID) {
              logToFile('session.idle without sessionID — ignoring');
              continue;
            }
            const currentSessionId = state.currentSession?.kiloSessionId;
            if (currentSessionId && sessionID !== currentSessionId) {
              logToFile(
                `ignoring session.idle for child session: event=${sessionID} current=${currentSessionId}`
              );
              continue;
            }
            logToFile('session.idle received');
            callbacks.onCompletionSignal();
            callbacks.onSessionIdle?.();
            // For new path, forward the idle event to DO (already done via normal ingest)
            // and let the DO schedule idle reconciliation.
          }
        }

        logToFile('SDK event stream ended');
        if (!abortController.signal.aborted && myGeneration === eventSubscriptionGeneration) {
          callbacks.onDisconnect('SDK event stream ended');
        }
      } catch (err) {
        if (!abortController.signal.aborted && myGeneration === eventSubscriptionGeneration) {
          const msg = err instanceof Error ? err.message : String(err);
          logToFile(`SDK event stream error: ${msg}`);
          callbacks.onDisconnect(`SDK event stream error: ${msg}`);
        }
      } finally {
        if (myGeneration === eventSubscriptionGeneration) {
          eventSubscriptionActive = false;
        }
      }
    })();
  }

  function attemptReconnect(): void {
    if (reconnecting) return;
    reconnecting = true;
    reconnectAttempt = 0;
    scheduleReconnect();
  }

  function completeReconnect(): void {
    logToFile(`reconnected successfully on attempt ${reconnectAttempt}`);
    reconnecting = false;
    reconnectAttempt = 0;
    // Re-store ingest WS in state (event subscription abort controller unchanged)
    const existingAbort = state.sseAbortController;
    if (ingestWs && existingAbort) {
      state.setConnections(ingestWs, existingAbort);
    }
    // Send fresh kilo state snapshot after reconnecting
    void sendKiloSnapshot();
    if (eventSubscriptionActive) {
      void resumeRestoredNetworkWaits();
    }
    // Re-push command catalog — DO cache may have been evicted in the interim.
    void sendCommandsAvailable();
    callbacks.onReconnected?.();
  }

  function discardStaleReconnect(): void {
    logToFile('reconnect succeeded but connection was closed — discarding stale socket');
    if (ingestWs) {
      try {
        ingestWs.close();
      } catch {
        /* ignore */
      }
      ingestWs = null;
    }
  }

  function scheduleReconnect(): void {
    reconnectAttempt++;
    if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      logToFile(`reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts — giving up`);
      reconnecting = false;
      reconnectAttempt = 0;
      callbacks.onDisconnect('ingest websocket closed (reconnection failed)');
      return;
    }

    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt - 1);
    logToFile(`reconnect attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    callbacks.onReconnecting?.(reconnectAttempt);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const gen = generation;
      openIngestWs(gen)
        .then(() => {
          if (gen !== generation) {
            discardStaleReconnect();
            return;
          }
          completeReconnect();
        })
        .catch((err: unknown) => {
          if (gen !== generation) return;
          const msg = err instanceof Error ? err.message : String(err);
          logToFile(`reconnect attempt ${reconnectAttempt} failed: ${msg}`);
          scheduleReconnect();
        });
    }, delay);
  }

  function cancelReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnecting = false;
    reconnectAttempt = 0;
  }

  return {
    open: async () => {
      logToFile('opening connections');

      // Open ingest WS first
      await openIngestWs();

      // Send initial kilo state snapshot
      await sendKiloSnapshot();

      // Push the slash-command catalog so the DO can hydrate connected clients.
      // Best-effort: fire-and-forget, doesn't block readiness.
      void sendCommandsAvailable();

      // Wait for the SDK event subscription handshake to complete before
      // returning. The caller (createPromptHandler) immediately POSTs
      // /prompt_async after this resolves — if the subscription is not yet
      // attached when the POST fires, fast kilo turns (hot session) publish
      // session.idle to an empty subscriber list and the wrapper hangs.
      try {
        await attachEventSubscription();
        void resumeRestoredNetworkWaits();
      } catch (err) {
        // Roll back the ingest WS + published state refs so open() is atomic.
        // Callers rely on `isConnected()` returning false when open() rejects,
        // and leaving a half-open WS or dangling state.sendToIngestFn behind
        // would misrepresent the wrapper as connected.
        eventSubscriptionAbort?.abort();
        eventSubscriptionAbort = null;
        eventSubscriptionActive = false;
        if (ingestWs) {
          closedByUs = true;
          try {
            ingestWs.close();
          } catch {
            // Ignore close errors
          }
          ingestWs = null;
          closedByUs = false;
        }
        state.clearConnectionRefs();
        state.setSendToIngestFn(null);
        throw err;
      }

      logToFile('connections opened');
    },

    close: async () => {
      logToFile('closing connections');
      generation++;
      cancelReconnect();
      clearBuffer();

      // Stop event subscription — abort the HTTP stream so the for-await
      // loop unblocks immediately instead of waiting for the next SSE event.
      eventSubscriptionAbort?.abort();
      eventSubscriptionAbort = null;
      eventSubscriptionActive = false;

      // Close ingest WS
      if (ingestWs) {
        closedByUs = true;
        try {
          ingestWs.close();
        } catch {
          // Ignore close errors
        }
        ingestWs = null;
      }
      closedByUs = false;

      // Clear state references
      state.clearConnectionRefs();
      state.setSendToIngestFn(null);

      logToFile('connections closed');
    },

    isConnected: () => {
      return ingestWs !== null && ingestWs.readyState === WebSocket.OPEN && eventSubscriptionActive;
    },

    isReconnecting: () => reconnecting,

    reconnectEventSubscription: () => {
      logToFile('reconnecting SDK event subscription');
      // attachEventSubscription() aborts the previous controller internally,
      // so no separate abort call is needed here. Callers of this method
      // (the SSE watchdog) do not await it; route failures through
      // onDisconnect so the lifecycle manager can act.
      void attachEventSubscription()
        .then(() => {
          if (eventSubscriptionActive) void resumeRestoredNetworkWaits();
        })
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          logToFile(`reconnect event subscription failed: ${msg}`);
          callbacks.onDisconnect(`reconnect event subscription failed: ${msg}`);
        });
    },

    sendKiloSnapshot,
  };
}
