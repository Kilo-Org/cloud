import type { IngestEvent } from '../../src/shared/protocol.js';
import { logToFile } from './utils.js';

/**
 * Type guard for checking if a value is a plain object (Record<string, unknown>).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * SSE event from the kilo serve /event endpoint.
 * The first event is always 'server.connected'.
 * Subsequent events are bus events from the kilo server.
 */
export type KiloSSEEvent = {
  /** Event type/name from SSE */
  event: string;
  /** Parsed JSON data */
  data: unknown;
};

/**
 * Options for creating an SSE consumer.
 */
export type SSEConsumerOptions = {
  /** Base URL of the kilo serve instance */
  baseUrl: string;
  /** Callback for each event received (excluding internal events like heartbeats) */
  onEvent: (event: IngestEvent) => void;
  /** Callback when any SSE event is received (including heartbeats) - for activity tracking */
  onActivity?: () => void;
  /** Callback when the SSE connection is established */
  onConnected?: () => void;
  /** Callback when the SSE connection is closed */
  onClose?: (reason: string) => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
};

/**
 * SSE consumer handle.
 */
export type SSEConsumer = {
  /** Stop consuming events and close the connection */
  stop: () => void;
  /** Check if still consuming */
  isActive: () => boolean;
};

/**
 * Map a kilo serve SSE event to an IngestEvent for forwarding to the cloud-agent ingest.
 *
 * The kilo serve emits events like:
 * - server.connected (initial connection event)
 * - session.* events
 * - message.* events (message_created, message_part_updated, message_completed, etc.)
 * - Various other bus events
 */
function mapToIngestEvent(sseEvent: KiloSSEEvent): IngestEvent | null {
  const timestamp = new Date().toISOString();

  // Skip internal SSE events that shouldn't be forwarded to ingest
  // - server.connected: initial connection ack
  // - server.heartbeat: SSE keepalive (30s interval)
  if (sseEvent.event === 'server.connected' || sseEvent.event === 'server.heartbeat') {
    return null;
  }

  // All other events are forwarded as 'kilocode' events
  // The data structure from kilo serve is: {type: "event.name", properties: {...}}
  // We spread the data and add 'event' field for consistency with existing consumers
  return {
    streamEventType: 'kilocode',
    data: {
      ...(isRecord(sseEvent.data) ? sseEvent.data : {}),
      event: sseEvent.event,
    },
    timestamp,
  };
}

/**
 * Parse SSE text format into event objects.
 * SSE format is:
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * @param chunk - The text chunk to parse
 * @param flush - If true, flush any pending event even without trailing delimiter
 */
function parseSSEChunk(chunk: string, flush = false): KiloSSEEvent[] {
  const events: KiloSSEEvent[] = [];
  const lines = chunk.split('\n');

  let currentEvent: string | null = null;
  let currentData: string[] = [];

  const emitEvent = () => {
    if (currentData.length === 0) {
      // No data collected, nothing to emit
      currentEvent = null;
      return;
    }

    const dataStr = currentData.join('\n');
    let data: unknown;
    try {
      data = dataStr ? JSON.parse(dataStr) : {};
    } catch {
      // If data isn't valid JSON, pass it as a string
      data = dataStr;
    }

    // Kilo server sends events in format: data: {"type": "event.name", "properties": {...}}
    // without an explicit "event:" field. Extract the event name from the data's "type" field.
    let eventName = currentEvent;
    if (eventName === null && isRecord(data) && typeof data.type === 'string') {
      eventName = data.type;
    }

    if (eventName !== null) {
      events.push({ event: eventName, data });
    }

    currentEvent = null;
    currentData = [];
  };

  for (const line of lines) {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      currentData.push(line.slice(5).trim());
    } else if (line === '' && currentData.length > 0) {
      // Empty line signals end of event (check data.length instead of currentEvent)
      emitEvent();
    }
  }

  // If flush is requested, emit any pending event without trailing delimiter
  if (flush) {
    emitEvent();
  }

  return events;
}

/**
 * Create an SSE consumer that connects to the kilo serve /event endpoint
 * and forwards events to the provided callback.
 */
export async function createSSEConsumer(opts: SSEConsumerOptions): Promise<SSEConsumer> {
  const url = `${opts.baseUrl}/event`;
  let active = true;
  const abortController = new AbortController();

  logToFile(`connecting to SSE endpoint: ${url}`);

  // Start consuming in background (fire and forget)
  void (async () => {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      logToFile('SSE connection established');
      opts.onConnected?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let chunkCount = 0;

      while (active) {
        const { done, value } = await reader.read();

        if (done) {
          logToFile(`SSE stream ended after ${chunkCount} chunks`);
          // Flush any remaining buffer content as a final event
          if (buffer.trim()) {
            const events = parseSSEChunk(buffer, true);
            for (const sseEvent of events) {
              opts.onActivity?.();
              const ingestEvent = mapToIngestEvent(sseEvent);
              if (ingestEvent) {
                opts.onEvent(ingestEvent);
              }
            }
          }
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        chunkCount++;

        // Log first few chunks and periodically after that
        if (chunkCount <= 3 || chunkCount % 20 === 0) {
          logToFile(
            `SSE chunk #${chunkCount}: ${chunk.length} bytes, preview=${chunk.slice(0, 100).replace(/\n/g, '\\n')}`
          );
        }

        // Process complete events (ended by double newline)
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? ''; // Keep incomplete part in buffer

        for (const part of parts) {
          if (!part.trim()) continue;

          const events = parseSSEChunk(part + '\n\n');
          for (const sseEvent of events) {
            logToFile(`SSE event parsed: type=${sseEvent.event}`);

            // Call activity callback for ALL events (including heartbeats)
            opts.onActivity?.();

            // Only forward non-internal events to ingest
            const ingestEvent = mapToIngestEvent(sseEvent);
            if (ingestEvent) {
              opts.onEvent(ingestEvent);
            }
          }
        }
      }

      opts.onClose?.('stream ended');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        opts.onClose?.('aborted');
      } else {
        logToFile(`SSE error: ${error instanceof Error ? error.message : String(error)}`);
        opts.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();

  return {
    stop: () => {
      if (active) {
        active = false;
        abortController.abort();
        logToFile('SSE consumer stopped');
      }
    },
    isActive: () => active,
  };
}

/**
 * Check if an SSE event indicates execution completion.
 * This is used to detect when a prompt has finished processing.
 */
export function isCompletionEvent(event: KiloSSEEvent): boolean {
  // Look for session status changes that indicate completion
  // The exact event names depend on kilo serve's bus events
  const completionEvents = [
    'session.completed',
    'session.idle',
    'message.completed',
    'assistant.completed',
  ];

  return completionEvents.includes(event.event);
}

/**
 * Check if an SSE event indicates an error that should terminate execution.
 */
export function isTerminalErrorEvent(event: KiloSSEEvent): {
  isTerminal: boolean;
  reason?: string;
} {
  // Check for payment/billing related errors
  if (event.event === 'payment_required' || event.event === 'insufficient_funds') {
    return { isTerminal: true, reason: event.event };
  }

  // Check for API errors in event data
  if (isRecord(event.data) && event.data.error) {
    const errorStr = String(event.data.error);
    if (
      errorStr.includes('payment') ||
      errorStr.includes('credit') ||
      errorStr.includes('balance') ||
      errorStr.includes('quota')
    ) {
      return { isTerminal: true, reason: errorStr };
    }
  }

  return { isTerminal: false };
}
