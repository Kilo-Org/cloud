import {
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  controlFrameSchema,
  sandboxHelloResultSchema,
  type ControlError,
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
  onReconnect?: () => void;
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
  ): void;
};

const CONNECT_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

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
  let socket: WebSocket | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let shutDown = false;
  let connectInFlight = false;
  let reconnectAttempt = 0;
  let firstConnect: Promise<void> | null = null;
  let firstConnectSettled = false;
  let resolveFirstConnect: (() => void) | null = null;
  let rejectFirstConnect: ((error: Error) => void) | null = null;

  function stopKeepalive(): void {
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
  }

  function startKeepalive(ws: WebSocket): void {
    stopKeepalive();
    keepalive = setInterval(() => {
      if (ws.readyState !== 1) return;
      ws.send(SANDBOX_CONTROL_AUTO_PING);
    }, KEEPALIVE_INTERVAL_MS);
    keepalive.unref();
  }

  function cancelReconnect(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function settleFirstSuccess(): void {
    if (firstConnectSettled) return;
    firstConnectSettled = true;
    resolveFirstConnect?.();
  }

  function settleFirstFailure(error: Error): void {
    if (firstConnectSettled) return;
    firstConnectSettled = true;
    rejectFirstConnect?.(error);
  }

  function discardSocket(ws: WebSocket): void {
    if (socket === ws) socket = null;
    if (ws.readyState === 0 || ws.readyState === 1) {
      ws.close();
    }
  }

  function armReconnect(reason: string): void {
    if (shutDown || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = (options.reconnectDelayMs ?? defaultReconnectDelayMs)(reconnectAttempt);
    options.log?.(`sandbox control reconnect scheduled in ${delay}ms (${reason})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (shutDown) return;
      void connectAttempt();
    }, delay);
    reconnectTimer.unref?.();
  }

  function watchSocket(ws: WebSocket, gen: number): void {
    const onLost = () => {
      ws.removeEventListener('close', onLost);
      ws.removeEventListener('error', onLost);
      if (shutDown || gen !== generation) return;
      stopKeepalive();
      if (socket === ws) socket = null;
      armReconnect('socket closed');
    };
    ws.addEventListener('close', onLost);
    ws.addEventListener('error', onLost);
  }

  async function connectAttempt(): Promise<void> {
    if (shutDown || connectInFlight) return;
    connectInFlight = true;
    const gen = ++generation;
    const openWebSocket = options.openWebSocket ?? defaultOpenWebSocket;
    const ws = openWebSocket(options.url, options.credential);
    socket = ws;
    try {
      await waitForOpen(ws);
      if (shutDown || gen !== generation) return;
      const requestId = crypto.randomUUID();
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
      ws.send(JSON.stringify(hello));
      await waitForHelloAndStatus(ws, requestId);
      if (shutDown || gen !== generation) return;
      if (options.onRequest) {
        attachInboundDispatcher(
          ws,
          options.onRequest,
          () => !shutDown && gen === generation && socket === ws
        );
      }
      startKeepalive(ws);
      watchSocket(ws, gen);
      reconnectAttempt = 0;
      if (firstConnectSettled) {
        options.onReconnect?.();
      } else {
        settleFirstSuccess();
      }
    } catch {
      discardSocket(ws);
      if (shutDown || gen !== generation) return;
      options.log?.('sandbox control connect failed');
      armReconnect('connect failed');
    } finally {
      connectInFlight = false;
    }
  }

  return {
    connect(): Promise<void> {
      if (shutDown) return Promise.reject(new Error('sandbox control client closed'));
      if (firstConnect) return firstConnect;
      firstConnect = new Promise<void>((resolve, reject) => {
        resolveFirstConnect = resolve;
        rejectFirstConnect = reject;
      });
      void connectAttempt();
      return firstConnect;
    },

    close(): void {
      if (shutDown) return;
      shutDown = true;
      cancelReconnect();
      stopKeepalive();
      generation += 1;
      const current = socket;
      socket = null;
      current?.close();
      settleFirstFailure(new Error('sandbox control client closed'));
    },

    sendEvent(event: string, payload: unknown, session?: SessionEventIdentity): void {
      if (!socket || socket.readyState !== 1) return;
      socket.send(
        JSON.stringify({
          type: 'event',
          event,
          ...(session ? { session } : {}),
          payload,
        })
      );
    },
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('sandbox control connect timeout'));
    }, CONNECT_TIMEOUT_MS);

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onFailure = () => {
      cleanup();
      reject(new Error('sandbox control connect failed'));
    };

    function cleanup(): void {
      clearTimeout(timeout);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onFailure);
      ws.removeEventListener('close', onFailure);
    }

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onFailure);
    ws.addEventListener('close', onFailure);
  });
}

function waitForHelloAndStatus(ws: WebSocket, helloRequestId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let helloComplete = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('sandbox.hello timeout'));
    }, HELLO_TIMEOUT_MS);

    function onFailure(): void {
      cleanup();
      reject(new Error('sandbox control closed before handshake'));
    }

    function onMessage(event: MessageEvent): void {
      if (typeof event.data !== 'string') return;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      const parsed = controlFrameSchema.safeParse(parsedJson);
      if (!parsed.success) return;

      if (parsed.data.type === 'response' && parsed.data.requestId === helloRequestId) {
        if (!parsed.data.ok) {
          cleanup();
          reject(new Error(parsed.data.error?.message ?? 'sandbox.hello failed'));
          return;
        }
        const result = sandboxHelloResultSchema.safeParse(parsed.data.result);
        if (!result.success) {
          cleanup();
          reject(new Error('Invalid sandbox.hello result'));
          return;
        }
        helloComplete = true;
        return;
      }

      if (
        helloComplete &&
        parsed.data.type === 'request' &&
        parsed.data.operation === 'sandbox.status'
      ) {
        ws.send(
          JSON.stringify({
            type: 'response',
            requestId: parsed.data.requestId,
            ok: true,
          })
        );
        cleanup();
        resolve();
      }
    }

    function cleanup(): void {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onFailure);
      ws.removeEventListener('close', onFailure);
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onFailure);
    ws.addEventListener('close', onFailure);
  });
}

function attachInboundDispatcher(
  ws: WebSocket,
  onRequest: SandboxControlRequestHandler,
  isCurrent: () => boolean
): void {
  async function onMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data !== 'string' || !isCurrent()) return;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(event.data) as unknown;
    } catch {
      return;
    }
    const parsed = controlFrameSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.type !== 'request') return;

    const request = parsed.data;
    let outcome: { ok: boolean; result?: unknown; error?: ControlError };
    try {
      outcome = await onRequest(request.operation, request.session, request.payload);
    } catch {
      outcome = {
        ok: false,
        error: { code: 'not_ready', message: 'Request handler failed', retryable: true },
      };
    }

    if (!isCurrent() || ws.readyState !== 1) return;
    if (outcome.ok) {
      ws.send(
        JSON.stringify({
          type: 'response',
          requestId: request.requestId,
          ok: true,
          ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        })
      );
      return;
    }
    ws.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: outcome.error ?? { code: 'not_ready', message: 'Request failed', retryable: true },
      })
    );
  }

  ws.addEventListener('message', event => {
    void onMessage(event);
  });
}
