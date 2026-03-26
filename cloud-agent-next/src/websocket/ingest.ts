/**
 * Ingest handler for the /ingest WebSocket endpoint.
 *
 * This module provides the internal WebSocket handler that:
 * - Accepts WebSocket connections from the wrapper process inside the sandbox
 * - Persists incoming events to SQLite storage
 * - Broadcasts events to connected /stream clients
 * - Handles kiloSessionId capture from session_created events
 * - Handles branch capture from complete events
 * - Handles execution lifecycle (complete/interrupted/error)
 *
 * The /ingest endpoint is internal-only - it should only be called
 * by the wrapper via DO fetch, not exposed to external clients.
 */

import type { IngestEvent, StoredEvent } from './types.js';
import type { ExecutionId, EventId, SessionId } from '../types/ids.js';
import type { EventQueries } from '../session/queries/index.js';
import { createErrorMessage } from './stream.js';
import { z } from 'zod';
import {
  handleKilocodeEvent,
  handleBranchCapture,
  handleExecutionComplete,
  extractEntityId,
  type KiloSessionCaptureState,
} from '../session/ingest-handlers/index.js';
import type { CompleteEventData, KilocodeEventData, CloudStatusData } from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Ingest Attachment
// ---------------------------------------------------------------------------

/** Debounce interval for heartbeat updates (30 seconds) */
const HEARTBEAT_DEBOUNCE_MS = 30_000;

const completeEventSchema = z.object({
  exitCode: z.number(),
  currentBranch: z.string().optional(),
  gateResult: z.enum(['pass', 'fail']).optional(),
});

const kilocodeEventSchema = z
  .object({
    event: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();

const interruptedEventSchema = z.object({
  reason: z.string().optional(),
  exitCode: z.number().optional(),
});

const errorEventSchema = z.object({
  fatal: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Persistence Allowlists
// ---------------------------------------------------------------------------

/**
 * Kilocode events with entity IDs are always persisted via upsert:
 *   - message.updated   → entity_id: message/{id}
 *   - message.part.updated → entity_id: part/{messageID}/{partId}
 * See extractEntityId() for the mapping.
 *
 * The sets below cover events persisted via **plain insert**.
 * Any event not covered by entity-ID upsert or these sets is broadcast-only:
 * delivered to /stream clients in real time but not written to SQLite.
 */

/** Non-kilocode stream event types persisted to SQLite via plain insert. */
const PERSISTED_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  'complete',
  'interrupted',
  'error',
  'autocommit_started',
  'autocommit_completed',
]);

/** Kilocode event names persisted to SQLite via plain insert (no entity-ID dedup). */
const PERSISTED_KILO_EVENT_NAMES: ReadonlySet<string> = new Set([
  'message.part.removed',
  'session.created',
  'session.updated',
  'session.status',
  'session.error',
  'session.idle',
  'session.turn.close',
]);

const createExecutionLifecycleContext = (doContext: IngestDOContext) => ({
  updateExecutionStatus: (
    id: string,
    status: 'completed' | 'failed' | 'interrupted',
    err?: string,
    gateResult?: 'pass' | 'fail'
  ) => doContext.updateExecutionStatus(id, status, err, gateResult),
  clearActiveExecution: () => doContext.clearActiveExecution(),
  getActiveExecutionId: () => doContext.getActiveExecutionId(),
  logger: console,
});

const isTerminalStatus = (status?: ExecutionData['status']) =>
  status === 'completed' || status === 'failed' || status === 'interrupted';

const shouldIgnoreTerminalEvent = async (
  executionId: ExecutionId,
  doContext: IngestDOContext
): Promise<boolean> => {
  const currentExecution = await doContext.getExecution(executionId);
  return Boolean(currentExecution && isTerminalStatus(currentExecution.status));
};

/**
 * Attachment data stored with ingest WebSocket connections.
 * This data persists across hibernation cycles.
 */
export type IngestAttachment = {
  /** Execution ID for this ingest connection */
  executionId: ExecutionId;
  /** Unix timestamp when connection was established */
  connectedAt: number;
  /** KiloSessionId capture state - tracks if we've already captured for this exec */
  kiloSessionState: KiloSessionCaptureState;
  /** Last heartbeat update timestamp for debouncing */
  lastHeartbeatUpdate: number;
  /** Last lastEventAt update timestamp for debouncing */
  lastEventAtUpdate: number;
};

// ---------------------------------------------------------------------------
// DO Context for handlers
// ---------------------------------------------------------------------------

/** Execution data needed for validation */
export type ExecutionData = {
  executionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
  ingestToken?: string;
};

/**
 * Context provided by the DO to the ingest handler for calling back
 * into the DO for kiloSessionId capture, branch update, and lifecycle.
 */
export type IngestDOContext = {
  /** Persist the kiloSessionId in DO metadata */
  updateKiloSessionId: (id: string) => Promise<void>;
  /** Persist the upstream branch in DO metadata */
  updateUpstreamBranch: (branch: string) => Promise<void>;
  /** Clear the active execution when done */
  clearActiveExecution: () => Promise<void>;
  /** Get the currently active execution ID (if any) */
  getActiveExecutionId: () => Promise<string | null>;
  /** Get execution data for validation (including ingestToken) */
  getExecution: (executionId: string) => Promise<ExecutionData | null>;
  /** Transition execution status to 'running' when wrapper connects */
  transitionToRunning: (executionId: string) => Promise<boolean>;
  /** Update execution heartbeat timestamp (debounced) */
  updateHeartbeat: (executionId: string, timestamp: number) => Promise<void>;
  /** Update lastEventAt timestamp for non-heartbeat events (debounced) */
  updateLastEventAt: (executionId: string, timestamp: number) => Promise<void>;
  /** Update execution status when complete/failed/interrupted */
  updateExecutionStatus: (
    executionId: string,
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
    gateResult?: 'pass' | 'fail'
  ) => Promise<void>;
  /** Cancel the disconnect grace period when wrapper reconnects */
  cancelDisconnectGrace?: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Ingest Handler Factory
// ---------------------------------------------------------------------------

/**
 * Create an ingest handler for the /ingest WebSocket endpoint.
 *
 * The handler uses Cloudflare's WebSocket hibernation API:
 * - `state.acceptWebSocket()` registers the WebSocket with hibernation support
 * - `serializeAttachment()` persists execution ID across hibernation cycles
 * - Uses `ingest:{executionId}` tags for identification
 *
 * @param state - Durable Object state for WebSocket management
 * @param eventQueries - Event queries module for persisting events
 * @param sessionId - Session ID for this DO instance
 * @param broadcastFn - Function to broadcast events to /stream clients
 * @param doContext - Context for calling back into DO for session capture, branch, and lifecycle
 * @returns Ingest handler object with methods for WebSocket operations
 */
export function createIngestHandler(
  state: DurableObjectState,
  eventQueries: EventQueries,
  sessionId: SessionId,
  broadcastFn: (event: StoredEvent) => void,
  doContext: IngestDOContext
) {
  return {
    /**
     * Handle incoming /ingest WebSocket upgrade request.
     *
     * Flow:
     * 1. Validate WebSocket upgrade header
     * 2. Extract and validate executionId and token from query params
     * 3. Validate execution exists and token matches
     * 4. Close any existing sockets for this execution (including hibernated ones)
     * 5. Transition execution status to 'running'
     * 6. Accept WebSocket with hibernation support and ingest tag
     * 7. Store execution ID in attachment for hibernation-safe access
     *
     * @param request - The incoming HTTP request with WebSocket upgrade
     * @returns HTTP response (101 on success, error status otherwise)
     */
    async handleIngestRequest(request: Request): Promise<Response> {
      // Verify it's a WebSocket upgrade
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const url = new URL(request.url);
      const executionId = url.searchParams.get('executionId') as ExecutionId | null;

      if (!executionId) {
        return new Response('Missing executionId parameter', { status: 400 });
      }

      // Validate execution exists and token matches
      const execution = await doContext.getExecution(executionId);
      if (!execution) {
        return new Response('Execution not found', { status: 404 });
      }

      if (execution.ingestToken !== executionId) {
        return new Response('Invalid executionId', { status: 401 });
      }

      // Allow connections only for pending or running executions
      if (execution.status !== 'pending' && execution.status !== 'running') {
        return new Response('Execution not active', { status: 409 });
      }

      // Close any existing ingest sockets for this execution (including
      // hibernated ones that wouldn't appear in an in-memory map).
      // state.getWebSockets() is the authoritative source — it survives
      // hibernation and excludes already-disconnected sockets.
      for (const existingWs of state.getWebSockets(`ingest:${executionId}`)) {
        try {
          existingWs.close(1000, 'Replaced by new connection');
        } catch {
          // Ignore close errors on already-closed connections
        }
      }

      // Transition execution status to 'running' if not already
      if (execution.status === 'pending') {
        await doContext.transitionToRunning(executionId);
      }

      // Create WebSocket pair
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      const now = Date.now();

      // Store execution ID and capture state in attachment for hibernation-safe access
      const attachment: IngestAttachment = {
        executionId,
        connectedAt: now,
        kiloSessionState: { captured: false },
        lastHeartbeatUpdate: now,
        lastEventAtUpdate: 0,
      };

      // Accept the WebSocket with hibernation support
      // Use ingest:{executionId} tag for identification
      state.acceptWebSocket(server, [`ingest:${executionId}`]);
      server.serializeAttachment(attachment);

      // Cancel any pending disconnect grace period — wrapper reconnected
      await doContext.cancelDisconnectGrace?.();

      // Set initial heartbeat
      void doContext.updateHeartbeat(executionId, now);

      return new Response(null, { status: 101, webSocket: client });
    },

    /**
     * Handle incoming message on an ingest WebSocket.
     *
     * Flow:
     * 1. Validate message is string (not binary)
     * 2. Get execution ID from attachment
     * 3. Parse and validate the ingest event
     * 4. Insert event into SQLite with RETURNING id
     * 5. Broadcast to /stream clients with eventId attached
     * 6. Update heartbeat (debounced to every 30 seconds)
     *
     * @param ws - The WebSocket that received the message
     * @param message - The incoming message (should be JSON string)
     */
    async handleIngestMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      if (typeof message !== 'string') {
        ws.send(
          JSON.stringify(createErrorMessage('WS_PROTOCOL_ERROR', 'Binary messages not supported'))
        );
        return;
      }

      // Get execution ID from attachment
      const attachment = ws.deserializeAttachment() as IngestAttachment | null;
      if (!attachment) {
        ws.send(
          JSON.stringify(createErrorMessage('WS_INTERNAL_ERROR', 'Missing connection attachment'))
        );
        return;
      }

      const { executionId } = attachment;

      try {
        // Parse the ingest event
        const ingestEvent = JSON.parse(message) as IngestEvent;

        // Validate required fields
        if (!ingestEvent.streamEventType) {
          ws.send(
            JSON.stringify(createErrorMessage('WS_PROTOCOL_ERROR', 'Missing streamEventType field'))
          );
          return;
        }

        // Normalize timestamp - use provided or current time
        const timestamp = ingestEvent.timestamp
          ? new Date(ingestEvent.timestamp).getTime()
          : Date.now();

        const payload = JSON.stringify(ingestEvent.data ?? {});
        const eventType = ingestEvent.streamEventType;

        let eventId: number;

        // Route event: broadcast-only, upsert, or plain insert.
        // Only events in the allowlists are written to SQLite;
        // everything else is broadcast to /stream clients with eventId 0.
        if (eventType === 'kilocode') {
          const kiloEventName = (ingestEvent.data as Record<string, unknown> | undefined)?.event as
            | string
            | undefined;
          const data = ingestEvent.data as Record<string, unknown>;
          const entityId = extractEntityId(kiloEventName ?? '', data);
          if (entityId) {
            eventId = eventQueries.upsert({
              executionId,
              sessionId,
              streamEventType: eventType,
              payload,
              timestamp,
              entityId,
            });
          } else if (kiloEventName && PERSISTED_KILO_EVENT_NAMES.has(kiloEventName)) {
            eventId = eventQueries.insert({
              executionId,
              sessionId,
              streamEventType: eventType,
              payload,
              timestamp,
            });
          } else {
            eventId = 0;
          }
        } else if (PERSISTED_STREAM_EVENT_TYPES.has(eventType)) {
          eventId = eventQueries.insert({
            executionId,
            sessionId,
            streamEventType: eventType,
            payload,
            timestamp,
          });
        } else {
          eventId = 0;
        }

        // Build stored event for broadcasting
        const storedEvent: StoredEvent = {
          id: eventId,
          execution_id: executionId,
          session_id: sessionId,
          stream_event_type: eventType,
          payload,
          timestamp,
        };

        // Broadcast to all /stream clients
        broadcastFn(storedEvent);

        // Update heartbeat (debounced to every HEARTBEAT_DEBOUNCE_MS)
        const now = Date.now();
        if (now - attachment.lastHeartbeatUpdate >= HEARTBEAT_DEBOUNCE_MS) {
          attachment.lastHeartbeatUpdate = now;
          ws.serializeAttachment(attachment);
          void doContext.updateHeartbeat(executionId, now);
        }

        // Update lastEventAt for non-heartbeat events (leading-edge throttle).
        // Events arriving within HEARTBEAT_DEBOUNCE_MS of the last write are
        // skipped — the stored timestamp may lag behind the true latest event
        // by up to the throttle window. This is fine because the only consumer
        // (checkHungExecution) uses a 2-minute timeout on a 2-minute alarm cycle.
        if (eventType !== 'heartbeat') {
          if (now - attachment.lastEventAtUpdate >= HEARTBEAT_DEBOUNCE_MS) {
            attachment.lastEventAtUpdate = now;
            ws.serializeAttachment(attachment);
            void doContext.updateLastEventAt(executionId, now);
          }
        }

        // -- Handler integrations --

        // Handle kilocode events (session ID capture)
        if (ingestEvent.streamEventType === 'kilocode') {
          const parsedKilocode = kilocodeEventSchema.safeParse(ingestEvent.data);
          if (parsedKilocode.success) {
            await handleKilocodeEvent(
              parsedKilocode.data as KilocodeEventData,
              attachment.kiloSessionState,
              {
                updateKiloSessionId: id => doContext.updateKiloSessionId(id),
                logger: console,
              }
            );
            // Re-serialize attachment since kiloSessionState may have changed
            ws.serializeAttachment(attachment);
          } else {
            console.warn('Invalid kilocode event payload', parsedKilocode.error);
          }
        }

        // Handle autocommit events — emit cloud.status for finalizing/ready.
        // Compare via string variable because the local StreamEventType union
        // does not include wrapper-only event names like autocommit_*.
        const eventTypeStr: string = eventType;
        if (eventTypeStr === 'autocommit_started') {
          broadcastFn({
            id: 0 as EventId,
            execution_id: executionId,
            session_id: sessionId,
            stream_event_type: 'cloud.status',
            payload: JSON.stringify({
              cloudStatus: {
                type: 'finalizing',
                step: 'committing',
                message: 'Committing changes...',
              },
            } satisfies CloudStatusData),
            timestamp,
          });
        }
        if (eventTypeStr === 'autocommit_completed') {
          broadcastFn({
            id: 0 as EventId,
            execution_id: executionId,
            session_id: sessionId,
            stream_event_type: 'cloud.status',
            payload: JSON.stringify({
              cloudStatus: { type: 'ready' },
            } satisfies CloudStatusData),
            timestamp,
          });
        }

        // Handle complete events (branch capture + lifecycle)
        if (ingestEvent.streamEventType === 'complete') {
          if (await shouldIgnoreTerminalEvent(executionId, doContext)) {
            return;
          }

          // Emit cloud.status = ready on successful completion
          broadcastFn({
            id: 0 as EventId,
            execution_id: executionId,
            session_id: sessionId,
            stream_event_type: 'cloud.status',
            payload: JSON.stringify({
              cloudStatus: { type: 'ready' },
            } satisfies CloudStatusData),
            timestamp,
          });

          const parsedComplete = completeEventSchema.safeParse(ingestEvent.data);
          if (!parsedComplete.success) {
            console.warn('Invalid complete event payload', parsedComplete.error);
            return;
          }
          await handleBranchCapture(parsedComplete.data as CompleteEventData, {
            updateUpstreamBranch: branch => doContext.updateUpstreamBranch(branch),
            logger: console,
          });
          await handleExecutionComplete(
            executionId,
            'completed',
            createExecutionLifecycleContext(doContext),
            undefined,
            parsedComplete.data.gateResult
          );
        }

        // Handle interrupted events
        if (ingestEvent.streamEventType === 'interrupted') {
          if (await shouldIgnoreTerminalEvent(executionId, doContext)) {
            return;
          }
          const parsedInterrupted = interruptedEventSchema.safeParse(ingestEvent.data);
          if (!parsedInterrupted.success) {
            console.warn('Invalid interrupted event payload', parsedInterrupted.error);
            return;
          }
          const interruptedData = parsedInterrupted.data;
          await handleExecutionComplete(
            executionId,
            'interrupted',
            createExecutionLifecycleContext(doContext),
            interruptedData.reason ?? 'User interrupted'
          );
        }

        // Handle fatal errors
        if (ingestEvent.streamEventType === 'error') {
          const parsedError = errorEventSchema.safeParse(ingestEvent.data);
          if (!parsedError.success) {
            console.warn('Invalid error event payload', parsedError.error);
            return;
          }
          const errorData = parsedError.data;
          if (errorData.fatal) {
            if (await shouldIgnoreTerminalEvent(executionId, doContext)) {
              return;
            }
            const fatalMessage = errorData.error ?? errorData.message ?? 'Fatal error';
            broadcastFn({
              id: 0 as EventId,
              execution_id: executionId,
              session_id: sessionId,
              stream_event_type: 'cloud.status',
              payload: JSON.stringify({
                cloudStatus: { type: 'error', message: fatalMessage },
              } satisfies CloudStatusData),
              timestamp,
            });
            await handleExecutionComplete(
              executionId,
              'failed',
              createExecutionLifecycleContext(doContext),
              fatalMessage
            );
          }
        }
      } catch (error) {
        console.error('Error processing ingest message:', error);
        ws.send(
          JSON.stringify(
            createErrorMessage(
              'WS_INTERNAL_ERROR',
              error instanceof Error ? error.message : 'Failed to process event'
            )
          )
        );
      }
    },

    /**
     * Handle ingest WebSocket close.
     *
     * Returns the executionId only when no other ingest sockets remain
     * for that execution — i.e. the wrapper is truly disconnected, not
     * just being replaced by a reconnection.
     *
     * Uses state.getWebSockets() which is authoritative across hibernation
     * and excludes already-disconnected sockets.
     *
     * @param ws - The WebSocket that closed
     */
    handleIngestClose(ws: WebSocket): ExecutionId | null {
      const attachment = ws.deserializeAttachment() as IngestAttachment | null;
      if (!attachment) return null;

      const { executionId } = attachment;

      // If another ingest socket still exists for this execution (e.g. a
      // replacement connection), the wrapper isn't truly gone.
      const remaining = state.getWebSockets(`ingest:${executionId}`);
      if (remaining.length > 0) return null;

      return executionId;
    },

    /**
     * Check if an execution has an active ingest connection.
     *
     * Uses state.getWebSockets() which is authoritative across hibernation
     * and excludes already-disconnected sockets.
     *
     * @param executionId - Execution ID to check
     * @returns True if there's an active connection for this execution
     */
    hasActiveConnection(executionId: ExecutionId): boolean {
      return state.getWebSockets(`ingest:${executionId}`).length > 0;
    },
  };
}

/** Type of the ingest handler object returned by createIngestHandler */
export type IngestHandler = ReturnType<typeof createIngestHandler>;
