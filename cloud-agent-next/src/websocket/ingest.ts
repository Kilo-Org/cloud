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
import type { ExecutionId, SessionId } from '../types/ids.js';
import type { EventQueries } from '../session/queries/index.js';
import { createErrorMessage } from './stream.js';
import { z } from 'zod';
import {
  handleKilocodeEvent,
  handleBranchCapture,
  handleExecutionComplete,
  type KiloSessionCaptureState,
} from '../session/ingest-handlers/index.js';
import type { CompleteEventData, KilocodeEventData } from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Ingest Attachment
// ---------------------------------------------------------------------------

/** Debounce interval for heartbeat updates (30 seconds) */
const HEARTBEAT_DEBOUNCE_MS = 30_000;

const completeEventSchema = z.object({
  exitCode: z.number(),
  currentBranch: z.string().optional(),
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

const createExecutionLifecycleContext = (doContext: IngestDOContext) => ({
  updateExecutionStatus: (
    id: string,
    status: 'completed' | 'failed' | 'interrupted',
    err?: string
  ) => doContext.updateExecutionStatus(id, status, err),
  clearActiveExecution: () => doContext.clearActiveExecution(),
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
  /** Link kiloSessionId to backend for analytics */
  linkKiloSessionInBackend: (id: string) => Promise<void>;
  /** Persist the upstream branch in DO metadata */
  updateUpstreamBranch: (branch: string) => Promise<void>;
  /** Clear the active execution when done */
  clearActiveExecution: () => Promise<void>;
  /** Get execution data for validation (including ingestToken) */
  getExecution: (executionId: string) => Promise<ExecutionData | null>;
  /** Transition execution status to 'running' when wrapper connects */
  transitionToRunning: (executionId: string) => Promise<boolean>;
  /** Update execution heartbeat timestamp (debounced) */
  updateHeartbeat: (executionId: string, timestamp: number) => Promise<void>;
  /** Update execution status when complete/failed/interrupted */
  updateExecutionStatus: (
    executionId: string,
    status: 'completed' | 'failed' | 'interrupted',
    error?: string
  ) => Promise<void>;
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
  // Track active ingest connections per execution
  // Note: This map is reset on hibernation, but we can reconstruct
  // from state.getWebSockets() using tags if needed
  const activeConnections = new Map<ExecutionId, WebSocket>();

  return {
    /**
     * Handle incoming /ingest WebSocket upgrade request.
     *
     * Flow:
     * 1. Validate WebSocket upgrade header
     * 2. Extract and validate executionId and token from query params
     * 3. Validate execution exists and token matches
     * 4. Close any existing connection for this execution
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

      // Check for existing connection - close old one if exists
      const existingWs = activeConnections.get(executionId);
      if (existingWs) {
        try {
          existingWs.close(1000, 'Replaced by new connection');
        } catch {
          // Ignore close errors on already-closed connections
        }
        activeConnections.delete(executionId);
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
      };

      // Accept the WebSocket with hibernation support
      // Use ingest:{executionId} tag for identification
      state.acceptWebSocket(server, [`ingest:${executionId}`]);
      server.serializeAttachment(attachment);

      // Track the connection
      activeConnections.set(executionId, server);

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

        // Insert into SQLite and get the auto-generated ID
        const eventId = eventQueries.insert({
          executionId,
          sessionId,
          streamEventType: ingestEvent.streamEventType,
          payload: JSON.stringify(ingestEvent.data ?? {}),
          timestamp,
        });

        // Build stored event for broadcasting
        const storedEvent: StoredEvent = {
          id: eventId,
          execution_id: executionId,
          session_id: sessionId,
          stream_event_type: ingestEvent.streamEventType,
          payload: JSON.stringify(ingestEvent.data ?? {}),
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
                linkToBackend: id => doContext.linkKiloSessionInBackend(id),
                logger: console,
              }
            );
            // Re-serialize attachment since kiloSessionState may have changed
            ws.serializeAttachment(attachment);
          } else {
            console.warn('Invalid kilocode event payload', parsedKilocode.error);
          }
        }

        // Handle complete events (branch capture + lifecycle)
        if (ingestEvent.streamEventType === 'complete') {
          if (await shouldIgnoreTerminalEvent(executionId, doContext)) {
            return;
          }
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
            createExecutionLifecycleContext(doContext)
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
            await handleExecutionComplete(
              executionId,
              'failed',
              createExecutionLifecycleContext(doContext),
              errorData.error ?? errorData.message ?? 'Fatal error'
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
     * Removes the connection from tracking if it's the current
     * connection for this execution (avoids removing a replacement
     * connection that was already established).
     *
     * @param ws - The WebSocket that closed
     */
    handleIngestClose(ws: WebSocket): void {
      const attachment = ws.deserializeAttachment() as IngestAttachment | null;
      if (attachment) {
        const { executionId } = attachment;
        // Only remove from tracking if this is the current connection for this execution
        if (activeConnections.get(executionId) === ws) {
          activeConnections.delete(executionId);
        }
      }
    },

    /**
     * Check if an execution has an active ingest connection.
     *
     * @param executionId - Execution ID to check
     * @returns True if there's an active connection for this execution
     */
    hasActiveConnection(executionId: ExecutionId): boolean {
      return activeConnections.has(executionId);
    },

    /**
     * Get count of active ingest connections.
     *
     * @returns Number of active ingest WebSocket connections
     */
    getActiveConnectionCount(): number {
      return activeConnections.size;
    },

    /**
     * Get WebSocket for a specific execution (for testing/debugging).
     *
     * @param executionId - Execution ID to get connection for
     * @returns WebSocket if found, undefined otherwise
     */
    getConnection(executionId: ExecutionId): WebSocket | undefined {
      return activeConnections.get(executionId);
    },
  };
}

/** Type of the ingest handler object returned by createIngestHandler */
export type IngestHandler = ReturnType<typeof createIngestHandler>;
