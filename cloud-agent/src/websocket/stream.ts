/**
 * Stream handler for the /stream WebSocket endpoint.
 *
 * This module provides the client-facing WebSocket handler that:
 * - Accepts WebSocket connections with hibernation support
 * - Replays historical events based on client filters
 * - Broadcasts new events to matching connected clients
 */

import type {
  StreamFilters,
  StreamEvent,
  StoredEvent,
  StreamAttachment,
  StreamError,
  StreamErrorCode,
} from './types.js';
import type { SessionId, EventId } from '../types/ids.js';
import { parseStreamFilters, matchesFilters } from './filters.js';
import type { EventQueries } from '../session/queries/index.js';

/**
 * Approximate byte budget per replay round.
 *
 * Each round lazily iterates the SQLite cursor, serializes events and sends
 * them over the WebSocket. Once the cumulative size of the serialized
 * messages in a round exceeds this threshold the round stops, the cursor
 * is abandoned, and a fresh query starts from the last sent event ID.
 *
 * This caps peak memory to roughly one round's worth of serialized JSON
 * regardless of how many events or how large each payload is.
 * At least one event is always sent per round to guarantee forward progress.
 */
const REPLAY_BATCH_BYTES = 1_048_576; // 1 MiB

// ---------------------------------------------------------------------------
// Event Formatting
// ---------------------------------------------------------------------------

/**
 * Format a stored event for sending to client.
 *
 * @param event - The stored event from SQLite
 * @param sessionId - The session ID to include in the envelope
 * @returns Formatted event envelope ready for JSON serialization
 */
export function formatStreamEvent(event: StoredEvent, sessionId: SessionId): StreamEvent {
  return {
    eventId: event.id,
    executionId: event.execution_id as StreamEvent['executionId'],
    sessionId,
    streamEventType: event.stream_event_type as StreamEvent['streamEventType'],
    timestamp: new Date(event.timestamp).toISOString(),
    data: JSON.parse(event.payload),
  };
}

/**
 * Create an error message to send to client.
 *
 * @param code - Error code identifying the type of error
 * @param message - Human-readable error description
 * @returns Error envelope ready for JSON serialization
 */
export function createErrorMessage(code: StreamErrorCode, message: string): StreamError {
  return { type: 'error', code, message };
}

// ---------------------------------------------------------------------------
// Stream Handler Factory
// ---------------------------------------------------------------------------

/**
 * Create a stream handler for the /stream WebSocket endpoint.
 *
 * The handler uses Cloudflare's WebSocket hibernation API for efficiency:
 * - `state.acceptWebSocket()` registers the WebSocket with hibernation support
 * - `serializeAttachment()` persists filter data across hibernation cycles
 * - `getWebSockets(tag)` retrieves sockets by tag for broadcasting
 *
 * @param state - Durable Object state for WebSocket management
 * @param eventQueries - Event queries module for replaying historical events
 * @param sessionId - Session ID for this DO instance
 * @returns Stream handler object with methods for WebSocket operations
 */
export function createStreamHandler(
  state: DurableObjectState,
  eventQueries: EventQueries,
  sessionId: SessionId
) {
  return {
    /**
     * Handle incoming /stream WebSocket upgrade request.
     *
     * Flow:
     * 1. Validate WebSocket upgrade header
     * 2. Parse query parameters into filters
     * 3. Accept WebSocket with hibernation support and 'stream' tag
     * 4. Store filters in attachment for hibernation-safe access
     * 5. Replay historical events matching filters
     * 6. Return the 101 Switching Protocols response
     *
     * @param request - The incoming HTTP request with WebSocket upgrade
     * @returns HTTP response (101 on success, error status otherwise)
     */
    async handleStreamRequest(request: Request): Promise<Response> {
      // Verify it's a WebSocket upgrade
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const url = new URL(request.url);
      const filters = parseStreamFilters(url, sessionId);

      // Create WebSocket pair
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // Store filters in attachment for hibernation-safe access
      const attachment: StreamAttachment = {
        filters,
        connectedAt: Date.now(),
      };

      // Accept the WebSocket with hibernation support
      // Use a single 'stream' tag since tags are capped at 10
      state.acceptWebSocket(server, ['stream']);
      server.serializeAttachment(attachment);

      // Replay historical events immediately after accepting
      await this.replayEvents(server, filters);

      return new Response(null, { status: 101, webSocket: client });
    },

    /**
     * Replay historical events to a newly connected client.
     *
     * Events are read lazily from the SQLite cursor one row at a time
     * via iterateByFilters(). Each round serializes and sends events
     * until the cumulative JSON size exceeds REPLAY_BATCH_BYTES, then
     * abandons the cursor and starts a fresh query from the last sent
     * event ID. At least one event is always sent per round so replay
     * always makes forward progress even when a single event exceeds
     * the byte budget.
     *
     * @param ws - The WebSocket connection to send events to
     * @param filters - The client's filter preferences
     */
    async replayEvents(ws: WebSocket, filters: StreamFilters): Promise<void> {
      try {
        let cursor: EventId | undefined = filters.fromId;

        for (;;) {
          if (ws.readyState !== WebSocket.OPEN) break;

          let bytesSent = 0;
          let eventsSent = 0;

          for (const event of eventQueries.iterateByFilters({
            fromId: cursor,
            executionIds: filters.executionIds,
            eventTypes: filters.eventTypes,
            startTime: filters.startTime,
            endTime: filters.endTime,
          })) {
            const message = JSON.stringify(formatStreamEvent(event, sessionId));
            ws.send(message);
            bytesSent += message.length;
            cursor = event.id;
            eventsSent++;

            if (bytesSent >= REPLAY_BATCH_BYTES) break;
          }

          // No events yielded — replay is complete
          if (eventsSent === 0) break;
        }
      } catch (error) {
        console.error('Error replaying events:', error);
        ws.send(
          JSON.stringify(
            createErrorMessage('WS_INTERNAL_ERROR', 'Failed to replay historical events')
          )
        );
      }
    },

    /**
     * Broadcast a new event to all matching /stream clients.
     *
     * For each connected WebSocket with the 'stream' tag:
     * 1. Deserialize the attachment to get filters
     * 2. Check if the event matches the client's filters
     * 3. Send the formatted event if it matches
     *
     * @param event - The stored event to broadcast
     */
    broadcastEvent(event: StoredEvent): void {
      const allWs = state.getWebSockets('stream');

      for (const ws of allWs) {
        try {
          // Get filters from attachment
          const attachment = ws.deserializeAttachment() as StreamAttachment | null;

          if (!attachment) continue;

          const { filters } = attachment;

          // Check if event matches this client's filters
          if (!matchesFilters(event, filters)) continue;

          // Send formatted event
          const formatted = formatStreamEvent(event, sessionId);
          ws.send(JSON.stringify(formatted));
        } catch (error) {
          console.error('Error broadcasting to WebSocket:', error);
          // Don't close the WebSocket on broadcast error - let the client handle reconnection
        }
      }
    },

    /**
     * Get count of connected stream clients.
     *
     * @returns Number of active WebSocket connections with 'stream' tag
     */
    getConnectedClientCount(): number {
      return state.getWebSockets('stream').length;
    },
  };
}

/** Type of the stream handler object returned by createStreamHandler */
export type StreamHandler = ReturnType<typeof createStreamHandler>;
