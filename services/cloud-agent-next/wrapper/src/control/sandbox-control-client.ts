import { setTimeout as delay } from 'node:timers/promises';
import {
  emitControlDiagnostic,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import { z } from 'zod';
import { prepareIngestFrame } from '../../../src/shared/ingest-frame.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';
import {
  CONTROL_OPERATIONS,
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  controlFrameSchema,
  controlErrorCodes,
  sandboxHelloResultSchema,
  sandboxHeartbeatPayloadSchema,
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
  onDiagnostic?: ControlDiagnosticReporter;
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
  | { kind: 'ready'; socket: WebSocket; dispose: () => void; kiloVersionHeartbeat: boolean }
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
  let eventSequence = 0;
  const diagnostic = (phase: string, ws?: WebSocket): void =>
    emitControlDiagnostic(options.onDiagnostic, 'control.socket', {
      phase,
      readyState: ws?.readyState,
      bufferedBytes: ws?.bufferedAmount,
    });

  function retireConnection(ws: WebSocket): void {
    if (state.kind !== 'ready' || state.socket !== ws) return;
    const current = state;
    diagnostic('retired', ws);
    state = { kind: 'closed' };
    current.dispose();
    options.onDisconnected?.();
  }

  async function dispatchRequest(ws: WebSocket, request: RequestFrame): Promise<void> {
    if (state.kind !== 'ready' || state.socket !== ws || !options.onRequest) return;
    const startedAt = Date.now();
    let errorCode: string | undefined;
    let retryable: boolean | undefined;
    const requestDiagnostic = (phase: string, ok?: boolean): void =>
      emitControlDiagnostic(options.onDiagnostic, 'control.request', {
        phase,
        operation: CONTROL_OPERATIONS.find(operation => operation === request.operation) ?? 'other',
        requestId: request.requestId,
        sessionId: request.session?.sessionId,
        kiloSessionId: request.session?.kiloSessionId,
        elapsedMs: Date.now() - startedAt,
        ok,
        errorCode,
        retryable,
      });
    requestDiagnostic('received');
    let outcome: Awaited<ReturnType<SandboxControlRequestHandler>>;
    try {
      outcome = await options.onRequest(request.operation, request.session, request.payload);
    } catch {
      outcome = {
        ok: false,
        error: { code: 'not_ready', message: 'Request handler failed', retryable: true },
      };
    }

    if (!outcome.ok) {
      errorCode = controlErrorCodes.find(code => code === outcome.error?.code) ?? 'other';
      retryable = outcome.error?.retryable;
    }
    requestDiagnostic('completed', outcome.ok);
    if (state.kind !== 'ready' || state.socket !== ws) {
      requestDiagnostic('response_skipped', outcome.ok);
      return;
    }
    if (ws.readyState !== 1) {
      requestDiagnostic('response_failed', outcome.ok);
      retireConnection(ws);
      return;
    }
    let response: string;
    try {
      response = JSON.stringify({
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
      });
    } catch {
      response = JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: {
          code: 'capture_failed',
          message: 'Response serialization failed',
          retryable: false,
        },
      });
    }
    if (Buffer.byteLength(response) > MAX_SANDBOX_CONTROL_FRAME_BYTES) {
      response = JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: {
          code: 'payload_too_large',
          message: 'Response exceeds size limit',
          retryable: false,
        },
      });
    }
    try {
      ws.send(response);
      requestDiagnostic('response_sent', outcome.ok);
    } catch {
      requestDiagnostic('response_failed', outcome.ok);
      retireConnection(ws);
    }
  }

  function connectAttempt(
    starting: Extract<ClientState, { kind: 'starting' }>,
    deadlineAt: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      diagnostic('opening');
      const ws = (options.openWebSocket ?? defaultOpenWebSocket)(options.url, options.credential);
      const signal = starting.abort.signal;
      const requestId = crypto.randomUUID();
      let phase: 'opening' | 'hello' | 'status' | 'finished' = 'opening';
      let kiloVersionHeartbeat = false;
      let timeout = setTimeout(fail, Math.min(CONNECT_TIMEOUT_MS, deadlineAt - Date.now()));

      function dispose(): void {
        phase = 'finished';
        clearTimeout(timeout);
        signal.removeEventListener('abort', fail);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('error', onFailure);
        ws.removeEventListener('close', onClose);
        if (ws.readyState === 0 || ws.readyState === 1) ws.close();
      }

      function fail(): void {
        if (phase === 'finished') return;
        diagnostic('failed', ws);
        dispose();
        reject(new Error('sandbox control connect failed'));
      }

      function onFailure(): void {
        diagnostic('failed', ws);
        if (state.kind === 'ready' && state.socket === ws) retireConnection(ws);
        else fail();
      }

      function onClose(event: CloseEvent): void {
        emitControlDiagnostic(options.onDiagnostic, 'control.socket', {
          phase: 'closed',
          closeCode: event.code,
          wasClean: event.wasClean,
          readyState: ws.readyState,
          bufferedBytes: ws.bufferedAmount,
        });
        onFailure();
      }

      function onOpen(): void {
        if (phase !== 'opening' || state !== starting) return;
        if (Date.now() >= deadlineAt) {
          fail();
          return;
        }
        diagnostic('opened', ws);
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
          diagnostic('hello_sent', ws);
        } catch {
          onFailure();
        }
      }

      function onMessage(event: MessageEvent): void {
        if (
          typeof event.data !== 'string' ||
          Buffer.byteLength(event.data) > MAX_SANDBOX_CONTROL_FRAME_BYTES
        )
          return;
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
          if (phase !== 'hello') return;
          const hello = sandboxHelloResultSchema.safeParse(frame.result);
          if (!frame.ok || !hello.success) {
            fail();
            return;
          }
          kiloVersionHeartbeat = hello.data.capabilities?.kiloVersionHeartbeat === true;
          phase = 'status';
          diagnostic('hello_accepted', ws);
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
            diagnostic('keepalive_failed', ws);
            retireConnection(ws);
            return;
          }
          try {
            ws.send(SANDBOX_CONTROL_AUTO_PING);
            diagnostic('keepalive_sent', ws);
          } catch {
            diagnostic('keepalive_failed', ws);
            retireConnection(ws);
          }
        }, KEEPALIVE_INTERVAL_MS);
        keepalive.unref();
        state = {
          kind: 'ready',
          socket: ws,
          kiloVersionHeartbeat,
          dispose: () => {
            clearInterval(keepalive);
            dispose();
          },
        };
        diagnostic('ready', ws);
        resolve();
      }

      signal.addEventListener('abort', fail, { once: true });
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onFailure);
      ws.addEventListener('close', onClose);
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
          emitControlDiagnostic(options.onDiagnostic, 'control.socket', {
            phase: 'connect_attempt',
            attempt,
          });
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
          emitControlDiagnostic(options.onDiagnostic, 'control.socket', {
            phase: 'retry_scheduled',
            attempt,
            delayMs,
          });
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
      diagnostic('closed', current.kind === 'ready' ? current.socket : undefined);
      state = { kind: 'closed' };
      if (current.kind === 'starting')
        current.abort.abort(new Error('sandbox control client closed'));
      else if (current.kind === 'ready') current.dispose();
    },

    sendEvent(event: string, payload: unknown, session?: SessionEventIdentity): boolean {
      eventSequence += 1;
      const category =
        event === 'session.event'
          ? payload !== null &&
            typeof payload === 'object' &&
            'type' in payload &&
            payload.type === 'session.message.outcome'
            ? 'outcome'
            : 'session_event'
          : event === 'session.preparing'
            ? 'preparing'
            : event === 'sandbox.heartbeat'
              ? 'heartbeat'
              : event === 'sandbox.ready'
                ? 'ready'
                : 'other';
      const eventDiagnostic = (phase: string, bytes?: number): void =>
        emitControlDiagnostic(options.onDiagnostic, 'control.event', {
          phase,
          category,
          sequence: eventSequence,
          kiloSessionId: session?.kiloSessionId,
          bytes,
          bufferedBytes: state.kind === 'ready' ? state.socket.bufferedAmount : undefined,
        });
      if (state.kind !== 'ready') {
        eventDiagnostic('skipped');
        return false;
      }
      const { socket } = state;
      if (socket.readyState !== 1) {
        eventDiagnostic('send_failed');
        retireConnection(socket);
        return false;
      }
      try {
        const heartbeat =
          event === 'sandbox.heartbeat' ? sandboxHeartbeatPayloadSchema.parse(payload) : null;
        if (heartbeat && !state.kiloVersionHeartbeat) delete heartbeat.kilo.version;
        const serialized = serializeEvent(event, heartbeat ?? payload, session);
        socket.send(serialized);
        eventDiagnostic('sent', Buffer.byteLength(serialized));
        return true;
      } catch {
        eventDiagnostic('send_failed');
        retireConnection(socket);
        return false;
      }
    },
  };
}
