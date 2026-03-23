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

  /**
   * Start the SDK event subscription. Runs in the background.
   * Replaces the old SSE consumer with a typed event stream from the SDK.
   */
  function startEventSubscription(): void {
    // Abort the previous subscription's HTTP stream (if any) before starting
    // a new one.  This ensures the old `for await` loop unblocks immediately
    // instead of lingering until the next server-sent event arrives.
    eventSubscriptionAbort?.abort();

    const myGeneration = ++eventSubscriptionGeneration;
    eventSubscriptionActive = true;
    const abortController = new AbortController();
    eventSubscriptionAbort = abortController;

    // Store connections in state for external reference
    if (ingestWs) {
      state.setConnections(ingestWs, abortController);
      state.setSendToIngestFn(sendToIngest);
    }

    void (async () => {
      try {
        const result = await config.kiloClient.sdkClient.event.subscribe({
          signal: abortController.signal,
        });
        if (!result.stream) {
          logToFile('No event stream returned from SDK');
          eventSubscriptionActive = false;
          callbacks.onDisconnect('No event stream from SDK');
          return;
        }

        logToFile('SDK event subscription started');

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

          // Build and forward ingest event
          const ingestEvent: IngestEvent = {
            streamEventType: 'kilocode',
            data: { ...properties, event: eventType, type: eventType, properties },
            timestamp: new Date().toISOString(),
          };

          const trimmed: IngestEvent = {
            ...ingestEvent,
            data: trimPayload(ingestEvent.streamEventType, ingestEvent.data),
          };
          sendToIngest(trimmed);
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

          // Auto-reject permission requests — Cloud Agent has no UI to answer them,
          // so unanswered permissions would block the session indefinitely.
          if (eventType === 'permission.asked') {
            const permissionId = typeof properties.id === 'string' ? properties.id : undefined;
            if (permissionId) {
              const permissionType =
                typeof properties.permission === 'string' ? properties.permission : 'unknown';
              logToFile(`auto-rejecting permission: id=${permissionId} type=${permissionType}`);
              config.kiloClient
                .answerPermission(permissionId, 'reject')
                .catch((err: unknown) =>
                  logToFile(
                    `failed to auto-reject permission ${permissionId}: ${err instanceof Error ? err.message : String(err)}`
                  )
                );
            }
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

      // Start SDK event subscription (runs in background)
      startEventSubscription();

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
      // startEventSubscription() aborts the previous controller internally,
      // so no separate abort call is needed here.
      startEventSubscription();
    },
  };
}
