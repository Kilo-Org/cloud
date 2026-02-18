/**
 * SSE consumer for kilo serve /event endpoint.
 *
 * Subscribes to the server-sent event stream and forwards structured events
 * to a callback. Used for observability (heartbeat enrichment, future
 * WebSocket streaming to the dashboard).
 */

import { parseSSEEventData, type KiloSSEEvent } from './types';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;

export type SSEConsumerOptions = {
  /** Port of the kilo serve instance */
  port: number;
  /** Called for each meaningful event (excludes heartbeats) */
  onEvent: (event: KiloSSEEvent) => void;
  /** Called on any SSE activity (including heartbeats) — for last-activity tracking */
  onActivity?: () => void;
  /** Called when the SSE stream ends permanently (after exhausting reconnect attempts) */
  onClose?: (reason: string) => void;
};

export type SSEConsumer = {
  stop: () => void;
  isActive: () => boolean;
};

/**
 * Parse SSE text format into event objects.
 *
 * SSE format:
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * kilo serve may also omit the `event:` line and embed the type inside the
 * data payload as `{ "type": "event.name", "properties": {...} }`.
 *
 * All event data is parsed through Zod at the IO boundary via `parseSSEEventData`.
 */
function parseSSEChunk(chunk: string, flush = false): KiloSSEEvent[] {
  const events: KiloSSEEvent[] = [];
  const lines = chunk.split('\n');

  let currentEvent: string | null = null;
  let currentData: string[] = [];

  const emit = () => {
    if (currentData.length === 0) {
      currentEvent = null;
      return;
    }

    const raw = currentData.join('\n');
    let jsonData: unknown;
    try {
      jsonData = raw ? JSON.parse(raw) : {};
    } catch {
      jsonData = { type: currentEvent ?? 'unknown', properties: { raw } };
    }

    // Parse through Zod at IO boundary
    const data = parseSSEEventData(jsonData);

    let eventName = currentEvent;
    if (eventName === null && typeof data.type === 'string') {
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
      emit();
    }
  }

  if (flush) emit();

  return events;
}

/** Events that indicate the agent finished its current task. */
const COMPLETION_EVENTS = new Set([
  'session.completed',
  'session.idle',
  'message.completed',
  'assistant.completed',
]);

export function isCompletionEvent(event: KiloSSEEvent): boolean {
  return COMPLETION_EVENTS.has(event.event);
}

/**
 * Create an SSE consumer that connects to `GET /event` on a kilo serve
 * instance and forwards parsed events.
 *
 * Automatically reconnects with exponential back-off (up to
 * MAX_RECONNECT_ATTEMPTS) if the stream drops unexpectedly.
 * Only calls `onClose` after all retries are exhausted or on explicit abort.
 */
export function createSSEConsumer(opts: SSEConsumerOptions): SSEConsumer {
  const url = `http://127.0.0.1:${opts.port}/event`;
  let active = true;
  const controller = new AbortController();

  void (async () => {
    let attempt = 0;

    while (active) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
        }

        if (!res.body) {
          throw new Error('SSE response has no body');
        }

        // Connected successfully — reset attempt counter
        attempt = 0;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (active) {
          const { done, value } = await reader.read();

          if (done) {
            // Flush remaining buffer
            if (buffer.trim()) {
              for (const evt of parseSSEChunk(buffer, true)) {
                opts.onActivity?.();
                if (evt.event !== 'server.connected' && evt.event !== 'server.heartbeat') {
                  opts.onEvent(evt);
                }
              }
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete events (separated by blank lines)
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            if (!part.trim()) continue;
            for (const evt of parseSSEChunk(part + '\n\n')) {
              opts.onActivity?.();
              if (evt.event !== 'server.connected' && evt.event !== 'server.heartbeat') {
                opts.onEvent(evt);
              }
            }
          }
        }

        // Stream ended cleanly — try to reconnect (server may have restarted)
        if (!active) break;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          opts.onClose?.('aborted');
          return;
        }
        console.error('SSE error:', err instanceof Error ? err.message : String(err));
      }

      // Reconnect with exponential back-off
      attempt++;
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        opts.onClose?.(`gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
        active = false;
        return;
      }

      const delay = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.log(`SSE reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}) in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }

    opts.onClose?.('stopped');
  })();

  return {
    stop: () => {
      if (active) {
        active = false;
        controller.abort();
      }
    },
    isActive: () => active,
  };
}
