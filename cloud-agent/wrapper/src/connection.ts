import type { IngestEvent, WrapperCommand } from '../../src/shared/protocol.js';
import { logToFile } from './utils.js';

export type ConnectionOptions = {
  ingestUrl: string;
  executionId: string;
  sessionId: string;
  userId: string;
  token: string; // Execution-specific ingest token
  kilocodeToken: string; // Session-level API token for Authorization header
};

export type Connection = {
  send: (event: IngestEvent) => void;
  onCommand: (handler: (cmd: WrapperCommand) => void) => void;
  close: () => Promise<void>;
};

type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> } | string | string[]
) => WebSocket;

export async function createConnection(opts: ConnectionOptions): Promise<Connection> {
  const url = new URL(opts.ingestUrl);
  url.searchParams.set('executionId', opts.executionId);
  url.searchParams.set('sessionId', opts.sessionId);
  url.searchParams.set('userId', opts.userId);

  let ws: WebSocket | null = null;
  let commandHandler: ((cmd: WrapperCommand) => void) | null = null;
  let isConnected = false;
  let isClosed = false;

  // Event buffer for disconnection periods (prevents event loss during reconnect)
  const MAX_BUFFER_SIZE = 1000;
  const eventBuffer: IngestEvent[] = [];
  let bufferOverflowed = false;

  const MAX_RECONNECT_ATTEMPTS = 5;
  const INITIAL_BACKOFF_MS = 1000;
  const MAX_BACKOFF_MS = 5000;

  // Single promise for initial connection - resolved once, never recreated
  let initialResolve: (() => void) | null = null;
  let initialReject: ((err: Error) => void) | null = null;
  const initialConnection = new Promise<void>((resolve, reject) => {
    initialResolve = resolve;
    initialReject = reject;
  });
  const WebSocketWithHeaders = WebSocket as unknown as WebSocketCtor;

  function attemptConnection(attemptNumber: number) {
    ws = new WebSocketWithHeaders(url.toString(), {
      headers: {
        Authorization: `Bearer ${opts.kilocodeToken}`,
      },
    });

    ws.onopen = () => {
      logToFile(`ingest websocket open attempt=${attemptNumber}`);
      isConnected = true;

      // Resolve initial connection promise (only matters on first connect)
      if (initialResolve) {
        initialResolve();
        initialResolve = null;
        initialReject = null;
      }

      // Flush buffered events on reconnect
      if (eventBuffer.length > 0 || bufferOverflowed) {
        // Send resume marker so DO knows we may have lost events
        if (!ws) return;
        ws.send(
          JSON.stringify({
            streamEventType: 'wrapper_resumed',
            timestamp: new Date().toISOString(),
            data: { bufferedEvents: eventBuffer.length, eventsLost: bufferOverflowed },
          })
        );
        // Flush buffer
        for (const event of eventBuffer) {
          ws.send(JSON.stringify(event));
        }
        eventBuffer.length = 0;
        bufferOverflowed = false;
      }
    };

    ws.onclose = () => {
      logToFile(`ingest websocket closed attempt=${attemptNumber}`);
      isConnected = false;
      if (isClosed) return; // Intentional close, don't reconnect

      const nextAttempt = attemptNumber + 1;
      if (nextAttempt <= MAX_RECONNECT_ATTEMPTS) {
        const backoff = Math.min(INITIAL_BACKOFF_MS * nextAttempt, MAX_BACKOFF_MS);
        setTimeout(() => attemptConnection(nextAttempt), backoff);
      } else if (initialReject) {
        // Never connected successfully - reject initial promise
        initialReject(new Error('WebSocket connection failed after max retries'));
        initialReject = null;
        initialResolve = null;
      }
      // If already connected once, we just stop trying (reaper will catch stale)
    };

    ws.onmessage = event => {
      try {
        const cmd = JSON.parse(String(event.data)) as WrapperCommand;
        commandHandler?.(cmd);
      } catch {
        /* ignore parse errors */
      }
    };

    ws.onerror = () => {
      logToFile(`ingest websocket error attempt=${attemptNumber}`);
      // onerror is always followed by onclose, handle reconnect there
    };
  }

  // Start first connection attempt
  attemptConnection(0);

  // Wait for initial connection (or failure after all retries)
  await initialConnection;

  // Heartbeat every 20s
  const heartbeat = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          streamEventType: 'heartbeat',
          data: { executionId: opts.executionId },
          timestamp: new Date().toISOString(),
        })
      );
    }
  }, 20_000);

  return {
    send: (event: IngestEvent) => {
      if (isConnected && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      } else {
        // Buffer events while disconnected
        if (eventBuffer.length < MAX_BUFFER_SIZE) {
          eventBuffer.push(event);
        } else {
          bufferOverflowed = true; // Will notify DO on reconnect
        }
      }
    },
    onCommand: handler => {
      commandHandler = handler;
    },
    close: async () => {
      isClosed = true; // Prevent reconnection attempts
      clearInterval(heartbeat);
      ws?.close();
    },
  };
}
