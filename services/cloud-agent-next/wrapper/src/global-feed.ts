import type { WrapperState, SessionContext } from './state.js';
import type { WrapperKiloClient } from './kilo-api.js';
import { logToFile } from './utils.js';

type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> } | string | string[]
) => WebSocket;

export type KiloGlobalFeedConnection = {
  close(): void;
  done: Promise<void>;
};

type OpenKiloGlobalFeedOptions = {
  state: WrapperState;
  kiloClient: WrapperKiloClient;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: WebSocketCtor;
  retryDelayMs?: number;
};

const OPEN_READY_STATE = 1;
const GLOBAL_FEED_RETRY_DELAY_MS = 1_000;
const MAX_GLOBAL_FEED_WEBSOCKET_BUFFERED_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

type RequiredGlobalFeedSession = SessionContext & {
  agentSessionId: string;
  kiloSessionId: string;
  ingestUrl: string;
  workerAuthToken: string;
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
};

function requireGlobalFeedSession(session: SessionContext | null): RequiredGlobalFeedSession {
  if (!session) {
    throw new Error('Cannot open Kilo global feed: no session context');
  }
  if (!session.kiloSessionId) {
    throw new Error('Cannot open Kilo global feed: missing kiloSessionId');
  }
  if (!session.ingestUrl) {
    throw new Error('Cannot open Kilo global feed: missing ingestUrl');
  }
  if (!session.workerAuthToken) {
    throw new Error('Cannot open Kilo global feed: missing workerAuthToken');
  }
  if (!session.agentSessionId) {
    throw new Error('Cannot open Kilo global feed: missing agentSessionId');
  }
  if (!session.wrapperRunId) {
    throw new Error('Cannot open Kilo global feed: missing wrapperRunId');
  }
  if (session.wrapperGeneration === undefined) {
    throw new Error('Cannot open Kilo global feed: missing wrapperGeneration');
  }
  if (!session.wrapperConnectionId) {
    throw new Error('Cannot open Kilo global feed: missing wrapperConnectionId');
  }
  return session as RequiredGlobalFeedSession;
}

export function buildKiloGlobalFeedWebSocketUrl(session: SessionContext): string {
  const feedSession = requireGlobalFeedSession(session);
  const url = new URL(feedSession.ingestUrl);
  if (url.pathname.endsWith('/ingest')) {
    url.pathname = `${url.pathname.slice(0, -'/ingest'.length)}/kilo-global-ingest`;
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/kilo-global-ingest`;
  }
  url.searchParams.set('kiloSessionId', feedSession.kiloSessionId);
  url.searchParams.set('wrapperRunId', feedSession.wrapperRunId);
  url.searchParams.set('wrapperGeneration', String(feedSession.wrapperGeneration));
  url.searchParams.set('wrapperConnectionId', feedSession.wrapperConnectionId);
  return url.toString();
}

function isSyntheticGlobalEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('payload' in value)) {
    return false;
  }
  const payload = (value as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null || !('type' in payload)) {
    return false;
  }
  const type = (payload as { type?: unknown }).type;
  return type === 'server.connected' || type === 'server.heartbeat';
}

function parseSseMessageBlock(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r\n|\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

function takeNextSseMessageBlock(buffer: string): { block: string; remainder: string } | null {
  const lfBoundary = buffer.indexOf('\n\n');
  const crlfBoundary = buffer.indexOf('\r\n\r\n');
  if (lfBoundary === -1 && crlfBoundary === -1) {
    return null;
  }

  if (crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary < lfBoundary)) {
    return {
      block: buffer.slice(0, crlfBoundary),
      remainder: buffer.slice(crlfBoundary + '\r\n\r\n'.length),
    };
  }

  return {
    block: buffer.slice(0, lfBoundary),
    remainder: buffer.slice(lfBoundary + '\n\n'.length),
  };
}

export async function* parseSseDataStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nextBlock = takeNextSseMessageBlock(buffer);
    while (nextBlock !== null) {
      buffer = nextBlock.remainder;
      const data = parseSseMessageBlock(nextBlock.block);
      if (data !== null) {
        yield data;
      }
      nextBlock = takeNextSseMessageBlock(buffer);
    }
  }

  buffer += decoder.decode();
  const trailing = parseSseMessageBlock(buffer);
  if (trailing !== null) {
    yield trailing;
  }
}

export function openKiloGlobalFeed(options: OpenKiloGlobalFeedOptions): KiloGlobalFeedConnection {
  const session = requireGlobalFeedSession(options.state.currentSession);
  const wsUrl = buildKiloGlobalFeedWebSocketUrl(session);
  const fetchImpl = options.fetchImpl ?? fetch;
  const WebSocketWithHeaders = (options.WebSocketImpl ?? WebSocket) as WebSocketCtor;
  const retryDelayMs = options.retryDelayMs ?? GLOBAL_FEED_RETRY_DELAY_MS;
  const closeController = new AbortController();
  let closed = false;
  let attemptAbortController: AbortController | undefined;
  let attemptWebSocket: WebSocket | undefined;

  function waitForRetry(): Promise<void> {
    if (closeController.signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        closeController.signal.removeEventListener('abort', onAbort);
        resolve();
      }, retryDelayMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      closeController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function closeAttemptSocket(ws: WebSocket | undefined): void {
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // Ignore close errors.
    }
  }

  async function runAttempt(): Promise<void> {
    const abortController = new AbortController();
    attemptAbortController = abortController;
    const ws = new WebSocketWithHeaders(wsUrl, {
      headers: {
        Authorization: `Bearer ${session.workerAuthToken}`,
      },
    });
    attemptWebSocket = ws;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      ws.onopen = () => {
        opened = true;
        logToFile(`kilo global feed WS connected to: ${wsUrl}`);
        resolve();
      };
      ws.onerror = () => {
        if (!opened) {
          reject(new Error(`Failed to connect Kilo global feed WebSocket: ${wsUrl}`));
          return;
        }
        abortController.abort(new Error('Kilo global feed WebSocket failed'));
      };
      ws.onclose = event => {
        if (!closed) {
          logToFile(
            `kilo global feed WS closed: code=${event.code} reason=${event.reason || '(none)'}`
          );
        }
        if (!opened) {
          reject(new Error(`Kilo global feed WebSocket closed before open: ${wsUrl}`));
          return;
        }
        abortController.abort(new Error('Kilo global feed WebSocket closed'));
      };
    });

    if (closed) return;

    const globalEventUrl = new URL('/global/event', options.kiloClient.serverUrl);
    const response = await fetchImpl(globalEventUrl, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: abortController.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Kilo global event stream failed: ${response.status}`);
    }

    for await (const data of parseSseDataStream(response.body)) {
      if (closed || abortController.signal.aborted) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        logToFile('kilo global feed ignored invalid JSON SSE frame');
        continue;
      }

      if (isSyntheticGlobalEnvelope(parsed)) {
        continue;
      }

      if (ws.readyState === OPEN_READY_STATE) {
        const serialized = JSON.stringify(parsed);
        const pendingBytes = ws.bufferedAmount + encoder.encode(serialized).byteLength;
        if (pendingBytes > MAX_GLOBAL_FEED_WEBSOCKET_BUFFERED_BYTES) {
          throw new Error('Kilo global feed WebSocket buffer limit exceeded');
        }
        ws.send(serialized);
      }
    }
  }

  const done = (async () => {
    while (!closed) {
      try {
        await runAttempt();
        if (!closed) {
          logToFile('kilo global feed stream ended; reconnecting');
        }
      } catch (error) {
        if (!closed) {
          logToFile(
            `kilo global feed stopped: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } finally {
        attemptAbortController?.abort();
        attemptAbortController = undefined;
        closeAttemptSocket(attemptWebSocket);
        attemptWebSocket = undefined;
      }

      if (!closed) {
        await waitForRetry();
      }
    }
  })();

  return {
    done,
    close: () => {
      closed = true;
      closeController.abort();
      attemptAbortController?.abort();
      closeAttemptSocket(attemptWebSocket);
      attemptWebSocket = undefined;
    },
  };
}
