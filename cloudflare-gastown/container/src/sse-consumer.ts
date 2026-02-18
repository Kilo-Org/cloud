/**
 * SSE consumer for kilo serve /event endpoint.
 *
 * Subscribes to the server-sent event stream and forwards structured events
 * to a callback. Used for observability (heartbeat enrichment, future
 * WebSocket streaming to the dashboard).
 */

import { parseSSEEventData, type KiloSSEEvent } from './types';

export type SSEConsumerOptions = {
  /** Port of the kilo serve instance */
  port: number;
  /** Called for each meaningful event (excludes heartbeats) */
  onEvent: (event: KiloSSEEvent) => void;
  /** Called on any SSE activity (including heartbeats) — for last-activity tracking */
  onActivity?: () => void;
  /** Called when the SSE stream ends or errors */
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
 */
export function createSSEConsumer(opts: SSEConsumerOptions): SSEConsumer {
  const url = `http://127.0.0.1:${opts.port}/event`;
  let active = true;
  const controller = new AbortController();

  void (async () => {
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

      opts.onClose?.('stream ended');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        opts.onClose?.('aborted');
      } else {
        console.error('SSE error:', err instanceof Error ? err.message : String(err));
        opts.onClose?.(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
