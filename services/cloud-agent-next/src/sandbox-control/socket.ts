import { logger } from '../logger.js';
import {
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  SANDBOX_CONTROL_WS_TAG,
  SANDBOX_HELLO_DEADLINE_MS,
  sandboxControlSocketAttachmentSchema,
  sessionRequestIdentitySchema,
  type ControlOperation,
  type RequestFrame,
  type ResponseFrame,
  type SandboxControlSocketAttachment,
  type SandboxHeartbeatPayload,
  type SessionEventIdentity,
  type SessionEventPayload,
  type SessionPreparingPayload,
  type SessionRequestIdentity,
} from '../shared/sandbox-control-protocol.js';
import {
  errorResponse,
  helloResult,
  isControlEvent,
  isControlOperation,
  isSessionOperation,
  okResponse,
  parseControlFrame,
  parseEventPayload,
  parseOperationPayload,
  parseSandboxHelloPayload,
} from './frames.js';
import {
  SandboxControlConnectionError,
  createControlRequestWaiters,
  type ControlRequestWaiters,
} from './waiters.js';

export type SandboxControlSocketState = DurableObjectState;

export type SandboxControlOutboundRequest = {
  operation: Exclude<ControlOperation, 'sandbox.hello'>;
  session?: SessionRequestIdentity;
  payload: unknown;
  timeoutMs?: number;
  expectedWrapperInstanceId?: string;
};

export type SandboxControlConnectionIdentity = {
  connectionId: string;
  providerInstanceId: string;
  wrapperInstanceId?: string;
};

export type SandboxControlSocketHooks = {
  onHandshakeComplete?(identity: SandboxControlConnectionIdentity): void | Promise<void>;
  onReady?(identity: SandboxControlConnectionIdentity): void | Promise<void>;
  onHeartbeat?(
    payload: SandboxHeartbeatPayload,
    identity: SandboxControlConnectionIdentity
  ): void | Promise<void>;
  onSessionEvent?(
    sessionIdentity: SessionEventIdentity | undefined,
    payload: SessionEventPayload,
    identity: SandboxControlConnectionIdentity
  ): void | Promise<void>;
  onSessionPreparing?(
    sessionIdentity: SessionEventIdentity | undefined,
    payload: SessionPreparingPayload,
    identity: SandboxControlConnectionIdentity
  ): void | Promise<void>;
  onSocketClosed?(
    handshakeComplete: boolean,
    identity?: SandboxControlConnectionIdentity
  ): void | Promise<void>;
};

export type SandboxControlSocketHandler = {
  accept(): Response;
  handleMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
  handleClose(ws: WebSocket): void | Promise<void>;
  closeAll(reason: string): void;
  closeHandshakenSockets(code: number, reason: string): void;
  sendRequest(input: SandboxControlOutboundRequest): Promise<ResponseFrame>;
  hasHandshakenSocket(): boolean;
  getConnectionIdentity(): SandboxControlConnectionIdentity | null;
  closeProvisionalSockets(): void;
};

function readAttachment(ws: WebSocket): SandboxControlSocketAttachment | null {
  const parsed = sandboxControlSocketAttachmentSchema.safeParse(ws.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(value));
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

type HandshakenSandboxControlSocket = {
  socket: WebSocket;
  identity: SandboxControlConnectionIdentity;
};

function readConnectionIdentity(
  attachment: SandboxControlSocketAttachment | null
): SandboxControlConnectionIdentity | null {
  if (
    !attachment?.handshakeComplete ||
    !attachment.connectionId ||
    !attachment.providerInstanceId
  ) {
    return null;
  }

  return {
    connectionId: attachment.connectionId,
    providerInstanceId: attachment.providerInstanceId,
    ...(attachment.wrapperInstanceId ? { wrapperInstanceId: attachment.wrapperInstanceId } : {}),
  };
}

function currentHandshakenSocket(
  state: SandboxControlSocketState
): HandshakenSandboxControlSocket | null {
  let current: WebSocket | null = null;
  let legacy: WebSocket | null = null;
  let ambiguousLegacy = false;

  for (const ws of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
    if (ws.readyState !== 1) continue;
    const attachment = readAttachment(ws);
    if (!attachment?.handshakeComplete || !attachment.providerInstanceId) continue;
    if (attachment.connectionId) {
      if (current) return null;
      current = ws;
      continue;
    }
    if (legacy) {
      ambiguousLegacy = true;
      continue;
    }
    legacy = ws;
  }

  if (current) {
    const identity = readConnectionIdentity(readAttachment(current));
    return identity ? { socket: current, identity } : null;
  }

  if (!legacy || ambiguousLegacy) return null;
  const attachment = readAttachment(legacy);
  if (!attachment?.handshakeComplete || !attachment.providerInstanceId || legacy.readyState !== 1) {
    return null;
  }

  const upgraded: SandboxControlSocketAttachment = {
    ...attachment,
    connectionId: crypto.randomUUID(),
  };
  legacy.serializeAttachment(upgraded);
  const identity = readConnectionIdentity(upgraded);
  return identity ? { socket: legacy, identity } : null;
}

function isProvisionalSocket(
  state: SandboxControlSocketState,
  ws: WebSocket,
  attachment: SandboxControlSocketAttachment | null
): attachment is SandboxControlSocketAttachment & { connectionId: string } {
  if (
    ws.readyState !== 1 ||
    !attachment ||
    attachment.handshakeComplete ||
    !attachment.connectionId
  ) {
    return false;
  }

  let original = false;
  for (const candidate of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
    const candidateAttachment = readAttachment(candidate);
    if (candidateAttachment?.connectionId !== attachment.connectionId) continue;
    if (candidate !== ws || original) return false;
    original = true;
  }
  return original;
}

function isCurrentConnection(
  state: SandboxControlSocketState,
  ws: WebSocket,
  identity: SandboxControlConnectionIdentity
): boolean {
  const current = currentHandshakenSocket(state);
  return (
    ws.readyState === 1 &&
    current?.socket === ws &&
    current.identity.connectionId === identity.connectionId
  );
}

export function createSandboxControlSocketHandler(
  state: SandboxControlSocketState,
  sandboxId: string,
  waiters: ControlRequestWaiters = createControlRequestWaiters(),
  hooks: SandboxControlSocketHooks = {}
): SandboxControlSocketHandler {
  const activatingConnections = new Set<string>();

  return {
    hasHandshakenSocket(): boolean {
      return currentHandshakenSocket(state) !== null;
    },

    getConnectionIdentity(): SandboxControlConnectionIdentity | null {
      return currentHandshakenSocket(state)?.identity ?? null;
    },

    closeProvisionalSockets(): void {
      for (const ws of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
        const attachment = readAttachment(ws);
        if (!attachment?.handshakeComplete) {
          closeSocket(ws, 1008, 'handshake_required');
        }
      }
    },

    closeHandshakenSockets(code: number, reason: string): void {
      waiters.rejectAll(reason);
      for (const ws of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
        const attachment = readAttachment(ws);
        if (attachment?.handshakeComplete) {
          closeSocket(ws, code, reason);
        }
      }
    },

    accept(): Response {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const attachment: SandboxControlSocketAttachment = {
        handshakeComplete: false,
        acceptedAt: Date.now(),
        connectionId: crypto.randomUUID(),
      };
      state.acceptWebSocket(server, [SANDBOX_CONTROL_WS_TAG]);
      server.serializeAttachment(attachment);
      logger.withFields({ sandboxId }).info('Sandbox control socket accepted');
      return new Response(null, { status: 101, webSocket: client });
    },

    async handleMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      if (ws.readyState !== 1) return;

      const attachment = readAttachment(ws);
      if (
        attachment &&
        !attachment.handshakeComplete &&
        Date.now() - attachment.acceptedAt > SANDBOX_HELLO_DEADLINE_MS
      ) {
        closeSocket(ws, 1008, 'handshake_required');
        return;
      }

      const parsed = parseControlFrame(message);
      if (!parsed.ok) {
        if (parsed.error.code === 'payload_too_large') {
          closeSocket(ws, 1009, 'payload_too_large');
          return;
        }
        closeSocket(ws, 1003, parsed.error.code);
        return;
      }

      const frame = parsed.frame;
      if (frame.type === 'request' && frame.operation === 'sandbox.hello') {
        if (!isProvisionalSocket(state, ws, attachment)) {
          sendJson(
            ws,
            errorResponse(
              frame.requestId,
              'protocol_error',
              'sandbox.hello requires an unconsumed provisional connection'
            )
          );
          if (!attachment?.handshakeComplete || currentHandshakenSocket(state)?.socket !== ws) {
            closeSocket(ws, 1008, 'invalid_handshake');
          }
          return;
        }

        const payload = parseSandboxHelloPayload(frame.payload);
        if (!payload) {
          sendJson(
            ws,
            errorResponse(frame.requestId, 'protocol_error', 'Invalid sandbox.hello payload')
          );
          return;
        }

        const identity: SandboxControlConnectionIdentity = {
          connectionId: attachment.connectionId,
          providerInstanceId: payload.providerInstanceId,
          ...(payload.wrapperInstanceId ? { wrapperInstanceId: payload.wrapperInstanceId } : {}),
        };
        const completed: SandboxControlSocketAttachment = {
          handshakeComplete: true,
          acceptedAt: attachment.acceptedAt,
          connectionId: identity.connectionId,
          protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
          providerInstanceId: identity.providerInstanceId,
          ...(identity.wrapperInstanceId ? { wrapperInstanceId: identity.wrapperInstanceId } : {}),
        };
        const superseded: WebSocket[] = [];
        let replaced = false;

        const provisionals: WebSocket[] = [];
        for (const existing of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
          if (existing === ws) continue;
          const existingAttachment = readAttachment(existing);
          if (existingAttachment) {
            replaced ||= existingAttachment.handshakeComplete;
            existing.serializeAttachment({
              handshakeComplete: false,
              acceptedAt: existingAttachment.acceptedAt,
            } satisfies SandboxControlSocketAttachment);
          }
          if (existingAttachment?.handshakeComplete) {
            superseded.push(existing);
          } else {
            provisionals.push(existing);
          }
        }

        ws.serializeAttachment(completed);
        if (replaced) waiters.rejectAll('Wrapper socket replaced');
        for (const existing of superseded) {
          closeSocket(existing, 4000, 'Replaced by new handshake');
        }
        for (const existing of provisionals) {
          closeSocket(existing, 1008, 'handshake_required');
        }

        activatingConnections.add(identity.connectionId);
        try {
          const activation = hooks.onHandshakeComplete?.(identity);
          if (activation) await activation;
        } finally {
          activatingConnections.delete(identity.connectionId);
        }

        if (!isCurrentConnection(state, ws, identity)) return;
        sendJson(ws, okResponse(frame.requestId, helloResult()));
        sendJson(ws, {
          type: 'request',
          requestId: crypto.randomUUID(),
          operation: 'sandbox.status',
          payload: {},
        });
        logger.withFields({ sandboxId }).info('Sandbox control handshake complete');
        return;
      }

      if (!attachment?.handshakeComplete) {
        if (frame.type === 'request') {
          sendJson(
            ws,
            errorResponse(frame.requestId, 'handshake_required', 'sandbox.hello is required first')
          );
        } else {
          closeSocket(ws, 1008, 'handshake_required');
        }
        return;
      }

      const current = currentHandshakenSocket(state);
      const identity = readConnectionIdentity(readAttachment(ws));
      if (
        !current ||
        current.socket !== ws ||
        !identity ||
        current.identity.connectionId !== identity.connectionId
      ) {
        closeSocket(ws, 1008, 'stale_connection');
        return;
      }
      if (activatingConnections.has(identity.connectionId)) return;

      if (frame.type === 'response') {
        waiters.settle(frame);
        return;
      }

      if (frame.type === 'event') {
        if (!isControlEvent(frame.event)) return;
        const eventPayload = parseEventPayload(frame.event, frame.payload);
        if (!eventPayload.ok) {
          logger
            .withFields({
              sandboxId,
              event: frame.event,
              error: eventPayload.error.message,
            })
            .warn('Control event payload rejected');
          return;
        }
        if (frame.event === 'sandbox.ready') {
          await hooks.onReady?.(identity);
        } else if (frame.event === 'sandbox.heartbeat') {
          await hooks.onHeartbeat?.(eventPayload.payload as SandboxHeartbeatPayload, identity);
        } else if (frame.event === 'session.event') {
          await hooks.onSessionEvent?.(
            frame.session,
            eventPayload.payload as SessionEventPayload,
            identity
          );
        } else if (frame.event === 'session.preparing') {
          await hooks.onSessionPreparing?.(
            frame.session,
            eventPayload.payload as SessionPreparingPayload,
            identity
          );
        }
        return;
      }

      if (!isControlOperation(frame.operation)) {
        sendJson(ws, errorResponse(frame.requestId, 'unknown_operation', 'Unknown operation'));
        return;
      }

      const payload = parseOperationPayload(frame.operation, frame.payload);
      if (!payload.ok) {
        sendJson(ws, errorResponse(frame.requestId, payload.error.code, payload.error.message));
        return;
      }

      if (
        isSessionOperation(frame.operation) &&
        !sessionRequestIdentitySchema.safeParse(frame.session).success
      ) {
        sendJson(
          ws,
          errorResponse(frame.requestId, 'protocol_error', 'session identity is required')
        );
        return;
      }

      sendJson(ws, errorResponse(frame.requestId, 'not_ready', 'Operation is not implemented'));
    },

    async handleClose(ws: WebSocket): Promise<void> {
      const attachment = readAttachment(ws);
      const handshakeComplete = attachment?.handshakeComplete === true;
      logger
        .withFields({
          sandboxId,
          handshakeComplete,
        })
        .info('Sandbox control socket closed');
      if (!handshakeComplete) return;

      const current = currentHandshakenSocket(state);
      if (current && current.socket !== ws) return;
      const remaining = state.getWebSockets(SANDBOX_CONTROL_WS_TAG).some(other => {
        if (other === ws || other.readyState !== 1) return false;
        return readAttachment(other)?.handshakeComplete === true;
      });
      if (remaining) return;

      const identity = readConnectionIdentity(readAttachment(ws)) ?? undefined;
      if (identity) activatingConnections.delete(identity.connectionId);
      waiters.rejectAll('Wrapper socket closed');
      await hooks.onSocketClosed?.(true, identity);
    },

    closeAll(reason: string): void {
      waiters.rejectAll(reason);
      for (const ws of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
        closeSocket(ws, 4001, reason);
      }
    },

    async sendRequest(input: SandboxControlOutboundRequest): Promise<ResponseFrame> {
      const payload = parseOperationPayload(input.operation, input.payload);
      if (!payload.ok) {
        throw new Error(payload.error.message);
      }
      if (
        isSessionOperation(input.operation) &&
        !sessionRequestIdentitySchema.safeParse(input.session).success
      ) {
        throw new Error('session identity is required');
      }

      const current = currentHandshakenSocket(state);
      if (
        !current ||
        current.socket.readyState !== 1 ||
        activatingConnections.has(current.identity.connectionId)
      ) {
        throw new SandboxControlConnectionError('No ready wrapper socket');
      }

      const requestId = crypto.randomUUID();
      const frame: RequestFrame = {
        type: 'request',
        requestId,
        operation: input.operation,
        payload: payload.payload,
        ...(input.session ? { session: input.session } : {}),
      };
      const pending = waiters.wait(requestId, input.timeoutMs);
      sendJson(current.socket, frame);
      return pending;
    },
  };
}
