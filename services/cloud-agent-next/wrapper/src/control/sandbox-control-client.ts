import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { prepareIngestFrame } from '../../../src/shared/ingest-frame.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  controlFrameSchema,
  sandboxHelloResultSchema,
  sessionEventPayloadSchema,
  type ControlError,
  type EventFrame,
  type SessionEventPayload,
  type RequestFrame,
  type SessionEventIdentity,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';

type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> } | string | string[]
) => WebSocket;

export type SandboxControlRequestHandler = (
  operation: string,
  session: SessionRequestIdentity | undefined,
  payload: unknown
) => Promise<{ ok: boolean; result?: unknown; error?: ControlError }>;

export type SandboxControlClientOptions = {
  url: string;
  credential: string;
  providerInstanceId: string;
  wrapperInstanceId?: string;
  wrapperVersion?: string;
  openWebSocket?: (url: string, credential: string) => WebSocket;
  onRequest?: SandboxControlRequestHandler;
  onDisconnected?: () => void;
  log?: (message: string) => void;
  reconnectDelayMs?: (attempt: number) => number;
};

export type SandboxControlClient = {
  connect(): Promise<void>;
  close(): void;
  sendEvent?(
    event: string,
    payload: unknown,
    session?: { directory: string; kiloSessionId?: string; rootKiloSessionId?: string }
  ): boolean;
};

type ClientState =
  | { kind: 'idle' }
  | { kind: 'starting'; promise: Promise<void>; abort: AbortController }
  | { kind: 'ready'; socket: WebSocket; dispose: () => void }
  | { kind: 'closed' };

const CONNECT_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const preparedEventSchema = z.object({
  streamEventType: z.string(),
  data: z.record(z.string(), z.unknown()),
});

function prepareSessionEvent(payload: SessionEventPayload): SessionEventPayload {
  const timestamp = payload.timestamp ?? new Date().toISOString();
  const event: IngestEvent =
    payload.type === 'autocommit_started' ||
    payload.type === 'autocommit_completed' ||
    payload.type === 'status'
      ? { streamEventType: payload.type, data: payload.properties, timestamp }
      : { streamEventType: 'kilocode', data: payload, timestamp };
  const frame = prepareIngestFrame(event);
  if (frame.kind === 'dropped') throw new Error('Control event could not be safely serialized');
  const prepared = preparedEventSchema.parse(JSON.parse(frame.serialized));
  return prepared.streamEventType === 'kilocode'
    ? sessionEventPayloadSchema.parse(prepared.data)
    : {
        type: prepared.streamEventType,
        properties: prepared.data,
        ...(payload.timestamp ? { timestamp: payload.timestamp } : {}),
      };
}

function serializeEvent(event: string, payload: unknown, session?: SessionEventIdentity): string {
  const sessionPayload =
    event === 'session.event' ? sessionEventPayloadSchema.parse(payload) : undefined;
  const frame: EventFrame = {
    type: 'event',
    event,
    ...(session ? { session } : {}),
    payload: sessionPayload ? prepareSessionEvent(sessionPayload) : payload,
  };
  let serialized = JSON.stringify(frame);
  const bytes = Buffer.byteLength(serialized);
  if (
    bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES &&
    sessionPayload &&
    sessionPayload.type !== 'session.message.outcome'
  ) {
    frame.payload = {
      type: 'wrapper_event_truncated',
      properties: {
        originalStreamEventType: 'kilocode',
        kiloEventName: sessionPayload.type,
        originalBytes: bytes,
        reason: 'oversized_control_event',
      },
    };
    serialized = JSON.stringify(frame);
  }
  if (Buffer.byteLength(serialized) > MAX_SANDBOX_CONTROL_FRAME_BYTES) {
    throw new Error('Control event exceeds the frame budget');
  }
  return serialized;
}

function defaultOpenWebSocket(url: string, credential: string): WebSocket {
  const WebSocketImpl = WebSocket as unknown as WebSocketCtor;
  return new WebSocketImpl(url, { headers: { Authorization: `Bearer ${credential}` } });
}

function defaultReconnectDelayMs(attempt: number): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return exp + Math.floor(Math.random() * 250);
}

export function createSandboxControlClient(
  options: SandboxControlClientOptions
): SandboxControlClient {
  const wrapperInstanceId = options.wrapperInstanceId;
  let state: ClientState = { kind: 'idle' };

  function retireConnection(ws: WebSocket): void {
    if (state.kind !== 'ready' || state.socket !== ws) return;
    const current = state;
    state = { kind: 'closed' };
    current.dispose();
    options.onDisconnected?.();
  }

  async function dispatchRequest(ws: WebSocket, request: RequestFrame): Promise<void> {
    if (state.kind !== 'ready' || state.socket !== ws || !options.onRequest) return;
    let outcome: Awaited<ReturnType<SandboxControlRequestHandler>>;
    try {
      outcome = await options.onRequest(request.operation, request.session, request.payload);
    } catch {
      outcome = {
        ok: false,
        error: { code: 'not_ready', message: 'Request handler failed', retryable: true },
      };
    }

    if (state.kind !== 'ready' || state.socket !== ws) return;
    if (ws.readyState !== 1) {
      retireConnection(ws);
      return;
    }
    try {
      ws.send(
        JSON.stringify({
          type: 'response',
          requestId: request.requestId,
          ...(outcome.ok
            ? { ok: true, ...(outcome.result !== undefined ? { result: outcome.result } : {}) }
            : {
                ok: false,
                error: outcome.error ?? {
                  code: 'not_ready',
                  message: 'Request failed',
                  retryable: true,
                },
              }),
        })
      );
    } catch {
      retireConnection(ws);
    }
  }

  function connectAttempt(
    starting: Extract<ClientState, { kind: 'starting' }>,
    deadlineAt: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = (options.openWebSocket ?? defaultOpenWebSocket)(options.url, options.credential);
      const signal = starting.abort.signal;
      const requestId = crypto.randomUUID();
      let phase: 'opening' | 'hello' | 'status' | 'finished' = 'opening';
      let timeout = setTimeout(fail, Math.min(CONNECT_TIMEOUT_MS, deadlineAt - Date.now()));

      function dispose(): void {
        phase = 'finished';
        clearTimeout(timeout);
        signal.removeEventListener('abort', fail);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('error', onFailure);
        ws.removeEventListener('close', onFailure);
        if (ws.readyState === 0 || ws.readyState === 1) ws.close();
      }

      function fail(): void {
        if (phase === 'finished') return;
        dispose();
        reject(new Error('sandbox control connect failed'));
      }

      function onFailure(): void {
        if (state.kind === 'ready' && state.socket === ws) retireConnection(ws);
        else fail();
      }

      function onOpen(): void {
        if (phase !== 'opening' || state !== starting) return;
        if (Date.now() >= deadlineAt) {
          fail();
          return;
        }
        phase = 'hello';
        clearTimeout(timeout);
        timeout = setTimeout(fail, Math.min(HELLO_TIMEOUT_MS, deadlineAt - Date.now()));
        const hello: RequestFrame = {
          type: 'request',
          requestId,
          operation: 'sandbox.hello',
          payload: {
            protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
            providerInstanceId: options.providerInstanceId,
            ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
            ...(options.wrapperVersion ? { wrapperVersion: options.wrapperVersion } : {}),
          },
        };
        try {
          ws.send(JSON.stringify(hello));
        } catch {
          onFailure();
        }
      }

      function onMessage(event: MessageEvent): void {
        if (typeof event.data !== 'string') return;
        if (state !== starting && !(state.kind === 'ready' && state.socket === ws)) return;
        if (state === starting && phase === 'finished') return;
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(event.data);
        } catch {
          return;
        }
        const parsed = controlFrameSchema.safeParse(parsedJson);
        if (!parsed.success) return;
        const frame = parsed.data;
        if (state.kind === 'ready') {
          if (frame.type === 'request') void dispatchRequest(ws, frame);
          return;
        }
        if (Date.now() >= deadlineAt) {
          fail();
          return;
        }
        if (phase === 'opening') return;
        if (frame.type === 'response' && frame.requestId === requestId) {
          if (!frame.ok || !sandboxHelloResultSchema.safeParse(frame.result).success) {
            fail();
            return;
          }
          phase = 'status';
          return;
        }
        if (
          phase !== 'status' ||
          frame.type !== 'request' ||
          frame.operation !== 'sandbox.status'
        ) {
          return;
        }
        try {
          ws.send(JSON.stringify({ type: 'response', requestId: frame.requestId, ok: true }));
        } catch {
          onFailure();
          return;
        }
        if (state !== starting || phase !== 'status') return;
        phase = 'finished';
        clearTimeout(timeout);
        signal.removeEventListener('abort', fail);
        ws.removeEventListener('open', onOpen);
        const keepalive = setInterval(() => {
          if (state.kind !== 'ready' || state.socket !== ws) return;
          if (ws.readyState !== 1) {
            retireConnection(ws);
            return;
          }
          try {
            ws.send(SANDBOX_CONTROL_AUTO_PING);
          } catch {
            retireConnection(ws);
          }
        }, KEEPALIVE_INTERVAL_MS);
        keepalive.unref();
        state = {
          kind: 'ready',
          socket: ws,
          dispose: () => {
            clearInterval(keepalive);
            dispose();
          },
        };
        resolve();
      }

      signal.addEventListener('abort', fail, { once: true });
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onFailure);
      ws.addEventListener('close', onFailure);
      if (signal.aborted || ws.readyState > 1) fail();
      else if (ws.readyState === 1) onOpen();
    });
  }

  async function connectUntilReady(
    starting: Extract<ClientState, { kind: 'starting' }>,
    deadlineAt: number
  ): Promise<void> {
    const signal = starting.abort.signal;
    const timeout = setTimeout(
      () => starting.abort.abort(new Error('sandbox control startup timeout')),
      deadlineAt - Date.now()
    );
    try {
      for (let attempt = 1; ; attempt += 1) {
        signal.throwIfAborted();
        if (Date.now() >= deadlineAt) throw new Error('sandbox control startup timeout');
        try {
          await connectAttempt(starting, deadlineAt);
          return;
        } catch {
          signal.throwIfAborted();
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) throw new Error('sandbox control startup timeout');
          options.log?.('sandbox control connect failed');
          const delayMs = Math.min(
            remaining,
            (options.reconnectDelayMs ?? defaultReconnectDelayMs)(attempt)
          );
          options.log?.(`sandbox control reconnect scheduled in ${delayMs}ms (connect failed)`);
          await delay(delayMs, undefined, { signal });
        }
      }
    } catch (error) {
      if (state === starting) state = { kind: 'closed' };
      signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    connect(): Promise<void> {
      if (state.kind === 'closed')
        return Promise.reject(new Error('sandbox control client closed'));
      if (state.kind === 'ready') return Promise.resolve();
      if (state.kind === 'starting') return state.promise;
      const deadlineAt = Date.now() + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS;
      const starting: Extract<ClientState, { kind: 'starting' }> = {
        kind: 'starting',
        abort: new AbortController(),
        promise: Promise.resolve().then(() => connectUntilReady(starting, deadlineAt)),
      };
      state = starting;
      return starting.promise;
    },

    close(): void {
      const current = state;
      state = { kind: 'closed' };
      if (current.kind === 'starting')
        current.abort.abort(new Error('sandbox control client closed'));
      else if (current.kind === 'ready') current.dispose();
    },

    sendEvent(event: string, payload: unknown, session?: SessionEventIdentity): boolean {
      if (state.kind !== 'ready') return false;
      const { socket } = state;
      if (socket.readyState !== 1) {
        retireConnection(socket);
        return false;
      }
      try {
        socket.send(serializeEvent(event, payload, session));
        return true;
      } catch {
        retireConnection(socket);
        return false;
      }
    },
  };
}
