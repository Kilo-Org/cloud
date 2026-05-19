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
import type { WrapperKiloClient } from './kilo-api.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCodeReviewJob(state: WrapperState): boolean {
  return state.currentJob?.platform === 'code-review';
}

function statusTypeFromProperties(properties: Record<string, unknown>): string | undefined {
  const status = properties.status;
  return isRecord(status) && typeof status.type === 'string' ? status.type : undefined;
}

function isInteractiveStatusType(statusType: string | undefined): boolean {
  return statusType === 'question' || statusType === 'permission';
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
  kiloClient: WrapperKiloClient
): void {
  if (!permissionId) return;
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

/** Maximum number of reconnection attempts before giving up.
 *  3 attempts ≈ 7s total (1+2+4), fitting within the DO's 10s grace period. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** Base delay for exponential backoff (1 second) */
const RECONNECT_BASE_DELAY_MS = 1_000;

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
  let eventSubscriptionListening = false;
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
    eventBuffer.length = 0;
    bufferOverflowed = false;
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
    const kiloSessionId = state.currentJob?.kiloSessionId;
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
      const kiloSessionId = state.currentJob?.kiloSessionId;
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
    const job = state.currentJob;
    if (!job) {
      throw new Error('Cannot open ingest WS: no job context');
    }

    const url = new URL(job.ingestUrl);
    url.searchParams.set('executionId', job.executionId);

    const wsUrl = url.toString();
    logToFile(`ingest WS connecting to: ${wsUrl}`);

    return new Promise<void>((resolve, reject) => {
      // Bun's WebSocket supports headers parameter
      const WebSocketWithHeaders = WebSocket as unknown as WebSocketCtor;

      // Use workerAuthToken (user JWT) for auth - ingestToken is just executionId for DO validation
      const ws = new WebSocketWithHeaders(wsUrl, {
        headers: {
          Authorization: `Bearer ${job.workerAuthToken}`,
        },
      });

      ws.onopen = () => {
        logToFile(`ingest WS connected to: ${wsUrl}`);
        // Guard against stale reconnect: if close() was called while we were
        // connecting, generation will have advanced and we must not adopt
        // this socket or flush buffered events through it.
        if (expectedGeneration !== undefined && expectedGeneration !== generation) {
          logToFile('stale reconnect detected in onopen — discarding socket');
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
        resolve();
      };

      ws.onclose = (event: CloseEvent) => {
        logToFile(
          `ingest WS closed: code=${event.code} reason=${event.reason || '(none)'} url=${wsUrl}`
        );
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
        if (!ingestWs) {
          reject(new Error(`Failed to connect to ingest: ${wsUrl}`));
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
      setTimeout(() => {
        if (!ingestWs) {
          ws.close();
          reject(new Error('Ingest connection timeout'));
        }
      }, 10_000);
    });
  }

  /**
   * Check if an event represents a terminal error (payment/billing/quota).
   */
  function isTerminalError(eventType: string, properties: Record<string, unknown>): boolean {
    if (eventType === 'payment_required' || eventType === 'insufficient_funds') {
      return true;
    }
    const error = properties.error;
    if (error) {
      const errorStr = typeof error === 'string' ? error : JSON.stringify(error);
      if (
        errorStr.includes('payment') ||
        errorStr.includes('credit') ||
        errorStr.includes('balance') ||
        errorStr.includes('quota')
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

    const currentSessionId = state.currentJob?.kiloSessionId;
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
   * Start the SDK event subscription. Runs in the background.
   * Replaces the old SSE consumer with a typed event stream from the SDK.
   */
  function startEventSubscription(): Promise<boolean> {
    // Abort the previous subscription's HTTP stream (if any) before starting
    // a new one.  This ensures the old `for await` loop unblocks immediately
    // instead of lingering until the next server-sent event arrives.
    eventSubscriptionAbort?.abort();

    const myGeneration = ++eventSubscriptionGeneration;
    eventSubscriptionListening = false;
    const abortController = new AbortController();
    eventSubscriptionAbort = abortController;
    let resolveStarted: (started: boolean) => void = () => {};
    let startedResolved = false;
    const startedPromise = new Promise<boolean>(resolve => {
      resolveStarted = resolve;
    });
    const markStarted = (started: boolean): void => {
      if (startedResolved) return;
      startedResolved = true;
      resolveStarted(started);
    };

    // Store connections in state for external reference
    if (ingestWs) {
      state.setConnections(ingestWs, abortController);
      state.setSendToIngestFn(sendToIngest);
    }

    void (async () => {
      try {
        // Arm the transport timer before subscribe() so a hung HTTP
        // request (or a stalled initial SSE handshake) is detected
        // within SSE_TRANSPORT_TIMEOUT_MS.
        callbacks.onSseEvent?.();

        const result = await config.kiloClient.sdkClient.event.subscribe({
          signal: abortController.signal,
        });
        if (!result.stream) {
          logToFile('No event stream returned from SDK');
          markStarted(false);
          callbacks.onDisconnect('No event stream from SDK');
          return;
        }

        logToFile('SDK event subscription stream returned');

        for await (const event of result.stream) {
          if (abortController.signal.aborted || myGeneration !== eventSubscriptionGeneration) break;

          // eventType is `string` so we can match untyped events like server.heartbeat
          const eventType: string = event.type ?? '';
          const properties: Record<string, unknown> = isRecord(event.properties)
            ? event.properties
            : {};

          // Track activity
          state.updateActivity();

          if (eventType === 'server.connected') {
            logToFile('SDK event subscription connected');
            eventSubscriptionListening = true;
            markStarted(true);
            callbacks.onSseEvent?.();
            continue;
          }

          // Forward kilo's heartbeat as ingest heartbeat (replaces wrapper's custom heartbeat)
          if (eventType === 'server.heartbeat') {
            const job = state.currentJob;
            if (job) {
              sendToIngest({
                streamEventType: 'heartbeat',
                data: { executionId: job.executionId },
                timestamp: new Date().toISOString(),
              });
            }
            callbacks.onSseEvent?.();
            continue;
          }

          // Auto-approve permission requests so the kilo server never stalls
          // waiting for a human response that will never come.
          if (eventType === 'permission.asked') {
            const permId = typeof properties.id === 'string' ? properties.id : undefined;
            if (isCodeReviewJob(state)) {
              rejectCodeReviewPermission(permId, config.kiloClient);
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
            const info = properties.info;
            if (isRecord(info) && info.role === 'assistant' && typeof info.id === 'string') {
              const msgSessionId = typeof info.sessionID === 'string' ? info.sessionID : undefined;
              const currentSessionId = state.currentJob?.kiloSessionId;
              if (!currentSessionId || msgSessionId === currentSessionId) {
                state.setLastAssistantMessageId(info.id);
              }
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
            const currentSessionId = state.currentJob?.kiloSessionId;
            if (currentSessionId && sessionID !== currentSessionId) {
              logToFile(
                `ignoring session.idle for child session: event=${sessionID} current=${currentSessionId}`
              );
              continue;
            }
            logToFile('session.idle received - marking as complete');
            callbacks.onMessageComplete('session.idle');
            callbacks.onCompletionSignal();
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
        markStarted(false);
        if (myGeneration === eventSubscriptionGeneration) {
          eventSubscriptionListening = false;
        }
      }
    })();

    return startedPromise;
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
    if (eventSubscriptionListening) {
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

      // Start SDK event subscription before resuming restored network waits.
      const eventSubscriptionStarted = startEventSubscription();

      void eventSubscriptionStarted.then(started => {
        if (started) void resumeRestoredNetworkWaits();
      });

      logToFile('connections opened');
    },

    close: async () => {
      logToFile('closing connections');
      generation++;
      cancelReconnect();

      // Stop event subscription — abort the HTTP stream so the for-await
      // loop unblocks immediately instead of waiting for the next SSE event.
      eventSubscriptionAbort?.abort();
      eventSubscriptionAbort = null;
      eventSubscriptionListening = false;

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
      return (
        ingestWs !== null && ingestWs.readyState === WebSocket.OPEN && eventSubscriptionListening
      );
    },

    isReconnecting: () => reconnecting,

    reconnectEventSubscription: () => {
      logToFile('reconnecting SDK event subscription');
      // startEventSubscription() aborts the previous controller internally,
      // so no separate abort call is needed here.
      void startEventSubscription().then(started => {
        if (started) void resumeRestoredNetworkWaits();
      });
    },

    sendKiloSnapshot,
  };
}
