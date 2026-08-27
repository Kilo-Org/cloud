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
};

export type SandboxControlSocketHooks = {
  onHandshakeComplete?(providerInstanceId: string): void | Promise<void>;
  onReady?(): void | Promise<void>;
  onHeartbeat?(payload: SandboxHeartbeatPayload): void | Promise<void>;
  onSessionEvent?(
    identity: SessionEventIdentity | undefined,
    payload: SessionEventPayload
  ): void | Promise<void>;
  onSessionPreparing?(
    identity: SessionEventIdentity | undefined,
    payload: SessionPreparingPayload
  ): void | Promise<void>;
  onSocketClosed?(handshakeComplete: boolean): void | Promise<void>;
};

export type SandboxControlSocketHandler = {
  accept(): Response;
  handleMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
  handleClose(ws: WebSocket): void | Promise<void>;
  closeAll(reason: string): void;
  closeHandshakenSockets(code: number, reason: string): void;
  sendRequest(input: SandboxControlOutboundRequest): Promise<ResponseFrame>;
  hasHandshakenSocket(): boolean;
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

function currentHandshakenSocket(state: SandboxControlSocketState): WebSocket | null {
  let current: WebSocket | null = null;
  let acceptedAt = -1;
  for (const ws of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
    if (ws.readyState !== 1) continue;
    const attachment = readAttachment(ws);
    if (!attachment?.handshakeComplete) continue;
    if (attachment.acceptedAt >= acceptedAt) {
      current = ws;
      acceptedAt = attachment.acceptedAt;
    }
  }
  return current;
}

export function createSandboxControlSocketHandler(
  state: SandboxControlSocketState,
  sandboxId: string,
  waiters: ControlRequestWaiters = createControlRequestWaiters(),
  hooks: SandboxControlSocketHooks = {}
): SandboxControlSocketHandler {
  return {
    hasHandshakenSocket(): boolean {
      return currentHandshakenSocket(state) !== null;
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
      };
      state.acceptWebSocket(server, [SANDBOX_CONTROL_WS_TAG]);
      server.serializeAttachment(attachment);
      logger.withFields({ sandboxId }).info('Sandbox control socket accepted');
      return new Response(null, { status: 101, webSocket: client });
    },

    async handleMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
      if (frame.type === 'response') {
        waiters.settle(frame);
        return;
      }

      if (frame.type === 'event') {
        if (!attachment?.handshakeComplete) {
          closeSocket(ws, 1008, 'handshake_required');
          return;
        }
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
          await hooks.onReady?.();
        } else if (frame.event === 'sandbox.heartbeat') {
          await hooks.onHeartbeat?.(eventPayload.payload as SandboxHeartbeatPayload);
        } else if (frame.event === 'session.event') {
          await hooks.onSessionEvent?.(frame.session, eventPayload.payload as SessionEventPayload);
        } else if (frame.event === 'session.preparing') {
          await hooks.onSessionPreparing?.(
            frame.session,
            eventPayload.payload as SessionPreparingPayload
          );
        }
        return;
      }

      if (frame.operation === 'sandbox.hello') {
        const payload = parseSandboxHelloPayload(frame.payload);
        if (!payload) {
          sendJson(
            ws,
            errorResponse(frame.requestId, 'protocol_error', 'Invalid sandbox.hello payload')
          );
          return;
        }

        const completed: SandboxControlSocketAttachment = {
          handshakeComplete: true,
          acceptedAt: attachment?.acceptedAt ?? Date.now(),
          protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
          providerInstanceId: payload.providerInstanceId,
        };
        ws.serializeAttachment(completed);

        let replaced = false;
        for (const existing of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
          if (existing === ws) continue;
          const existingAttachment = readAttachment(existing);
          if (existingAttachment?.handshakeComplete) {
            closeSocket(existing, 4000, 'Replaced by new handshake');
            replaced = true;
          }
        }
        if (replaced) waiters.rejectAll('Wrapper socket replaced');

        sendJson(ws, okResponse(frame.requestId, helloResult()));
        sendJson(ws, {
          type: 'request',
          requestId: crypto.randomUUID(),
          operation: 'sandbox.status',
          payload: {},
        });
        logger.withFields({ sandboxId }).info('Sandbox control handshake complete');
        await hooks.onHandshakeComplete?.(payload.providerInstanceId);
        return;
      }

      if (!attachment?.handshakeComplete) {
        sendJson(
          ws,
          errorResponse(frame.requestId, 'handshake_required', 'sandbox.hello is required first')
        );
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
      const remaining = state
        .getWebSockets(SANDBOX_CONTROL_WS_TAG)
        .some(other => other !== ws && readAttachment(other)?.handshakeComplete === true);
      if (remaining) return;
      waiters.rejectAll('Wrapper socket closed');
      await hooks.onSocketClosed?.(true);
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

      const ws = currentHandshakenSocket(state);
      if (!ws || ws.readyState !== 1) {
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
      sendJson(ws, frame);
      return pending;
    },
  };
}
