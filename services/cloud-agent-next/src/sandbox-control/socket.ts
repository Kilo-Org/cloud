import {
  diagnosticConnection,
  diagnosticEventType,
  logControlDiagnostic,
  type ControlDiagnosticFields,
} from './diagnostics.js';
import {
  safeSandboxRuntimeVersion,
  type SandboxRuntimeMetadata,
} from '../shared/sandbox-status.js';
import {
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  SANDBOX_CONTROL_WS_TAG,
  SANDBOX_HELLO_DEADLINE_MS,
  sandboxControlSocketAttachmentSchema,
  sandboxControlObservationSchema,
  sessionOperationAuthorizationSchema,
  sessionOperationDeliverySchema,
  type SandboxControlObservation,
  sessionRequestIdentitySchema,
  type ControlOperation,
  type RequestFrame,
  type ResponseFrame,
  type SandboxControlSocketAttachment,
  type SandboxHeartbeatPayload,
  type SessionEventIdentity,
  type SessionEventPayload,
  type SessionOperationAck,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
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
import { summarizeHeartbeatIdle } from './status-projection.js';

export type SandboxControlSocketState = DurableObjectState;

export type SandboxControlOutboundRequest = {
  operation: Exclude<ControlOperation, 'sandbox.hello'>;
  session?: SessionRequestIdentity;
  payload: unknown;
  authorization?: SessionOperationAuthorization;
  timeoutMs?: number;
  expectedWrapperInstanceId?: string;
  deadlineAt?: number;
};

export type SandboxControlConnectionIdentity = {
  connectionId: string;
  providerInstanceId: string;
  wrapperInstanceId?: string;
};

export type SandboxControlSocketHooks = {
  validateHandshake?(providerInstanceId: string): boolean | Promise<boolean>;
  onHandshakeComplete?(
    identity: SandboxControlConnectionIdentity,
    runtime?: Pick<SandboxRuntimeMetadata, 'wrapperVersion'>
  ): void | Promise<void>;
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
  onOperationResult?(
    session: SessionRequestIdentity,
    delivery: SessionOperationDelivery,
    identity: SandboxControlConnectionIdentity
  ): Promise<SessionOperationAck | undefined> | SessionOperationAck | undefined;
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
  supportsOperationResults(): boolean;
  supportsScopedStopAbort(): boolean;
  getConnectionIdentity(): SandboxControlConnectionIdentity | null;
  getReadySocket(): WebSocket | null;
  closeProvisionalSockets(): void;
};

const operationalAttachmentSchema = sandboxControlSocketAttachmentSchema.extend({
  observation: sandboxControlObservationSchema.optional().catch(undefined),
});

function readAttachment(ws: WebSocket): SandboxControlSocketAttachment | null {
  const parsed = operationalAttachmentSchema.safeParse(ws.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

export type SandboxControlConnectionObservation =
  | { state: 'disconnected' }
  | { state: 'unknown' }
  | { state: 'connected'; acceptedAt: number; observation: SandboxControlObservation };

const observedRuntimeSchema = sandboxControlSocketAttachmentSchema
  .pick({ connectionId: true, providerInstanceId: true, wrapperInstanceId: true })
  .required({ connectionId: true, providerInstanceId: true })
  .extend({ readyConnectionId: sandboxControlSocketAttachmentSchema.shape.connectionId });

export function readSandboxControlConnection(
  state: Pick<DurableObjectState, 'getWebSockets'>,
  providerRef: string | null,
  runtime: unknown
): SandboxControlConnectionObservation {
  let current: SandboxControlSocketAttachment | undefined;
  for (const ws of state.getWebSockets(SANDBOX_CONTROL_WS_TAG)) {
    if (ws.readyState !== 1) continue;
    const parsed = sandboxControlSocketAttachmentSchema.safeParse(ws.deserializeAttachment());
    if (!parsed.success) return { state: 'unknown' };
    if (!parsed.data.handshakeComplete) continue;
    if (current) return { state: 'unknown' };
    current = parsed.data;
  }
  if (!current) return { state: 'disconnected' };
  const expected = observedRuntimeSchema.safeParse(runtime);
  if (
    !expected.success ||
    current.connectionId !== expected.data.connectionId ||
    current.providerInstanceId !== expected.data.providerInstanceId ||
    current.wrapperInstanceId !== expected.data.wrapperInstanceId ||
    (current.observation?.ready && expected.data.readyConnectionId !== current.connectionId) ||
    current.protocolVersion !== SANDBOX_CONTROL_PROTOCOL_VERSION ||
    current.providerInstanceId !== providerRef ||
    !current.observation ||
    !Number.isSafeInteger(current.acceptedAt) ||
    current.observation.receivedAt < current.acceptedAt
  ) {
    return { state: 'unknown' };
  }
  return {
    state: 'connected',
    acceptedAt: current.acceptedAt,
    observation: current.observation,
  };
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(value));
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  const attachment = readAttachment(ws);
  if (attachment) {
    ws.serializeAttachment({ ...attachment, kiloReady: false });
  }
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
  const log = (event: string, fields: ControlDiagnosticFields) =>
    logControlDiagnostic(event, { sandboxId, ...fields });
  const observations = new WeakMap<WebSocket, SandboxControlObservation>();

  function recordObservation(ws: WebSocket, ready: boolean): SandboxControlObservation | undefined {
    if (currentHandshakenSocket(state)?.socket !== ws) return undefined;
    const attachment = readAttachment(ws);
    if (!attachment) return undefined;
    const observation: SandboxControlObservation = { ready, receivedAt: Date.now(), idle: null };
    observations.set(ws, observation);
    ws.serializeAttachment({ ...attachment, kiloReady: ready, observation });
    return observation;
  }

  function invalidateIdleObservation(
    ws: WebSocket,
    attachment: SandboxControlSocketAttachment
  ): void {
    if (currentHandshakenSocket(state)?.socket !== ws) return;
    observations.delete(ws);
    if (!attachment.observation?.idle) return;
    ws.serializeAttachment({
      ...attachment,
      observation: { ...attachment.observation, idle: null },
    });
  }

  return {
    hasHandshakenSocket(): boolean {
      return currentHandshakenSocket(state) !== null;
    },

    supportsOperationResults(): boolean {
      const current = currentHandshakenSocket(state);
      return (
        current !== null &&
        readAttachment(current.socket)?.capabilities?.sessionOperationResults === true
      );
    },

    supportsScopedStopAbort(): boolean {
      const current = currentHandshakenSocket(state);
      return (
        current !== null && readAttachment(current.socket)?.capabilities?.scopedStopAbort === true
      );
    },

    getConnectionIdentity(): SandboxControlConnectionIdentity | null {
      return currentHandshakenSocket(state)?.identity ?? null;
    },

    getReadySocket(): WebSocket | null {
      const ws = currentHandshakenSocket(state)?.socket;
      return ws && readAttachment(ws)?.kiloReady === true ? ws : null;
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
      log('socket_accepted', { connectionId: attachment.connectionId });
      return new Response(null, { status: 101, webSocket: client });
    },

    async handleMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      if (ws.readyState !== 1) {
        log('socket_frame_rejected', { reason: 'socket_not_open' });
        return;
      }

      const attachment = readAttachment(ws);
      const diagnostic = {
        connectionId: attachment?.connectionId,
        wrapperInstanceId: attachment?.wrapperInstanceId,
        handshakeComplete: attachment?.handshakeComplete ?? false,
      };
      if (
        attachment &&
        !attachment.handshakeComplete &&
        Date.now() - attachment.acceptedAt > SANDBOX_HELLO_DEADLINE_MS
      ) {
        log('socket_frame_rejected', { ...diagnostic, reason: 'handshake_expired' });
        closeSocket(ws, 1008, 'handshake_required');
        return;
      }

      const parsed = parseControlFrame(message);
      if (!parsed.ok) {
        log('socket_frame_rejected', { ...diagnostic, reason: parsed.error.code });
        if (parsed.error.code === 'payload_too_large') {
          closeSocket(ws, 1009, 'payload_too_large');
          return;
        }
        closeSocket(ws, 1003, parsed.error.code);
        return;
      }

      const frame = parsed.frame;
      let eventType = frame.type === 'event' ? diagnosticEventType(frame.event) : undefined;
      if (
        frame.type === 'event' &&
        frame.event === 'session.event' &&
        typeof frame.payload === 'object' &&
        frame.payload !== null &&
        'type' in frame.payload &&
        typeof frame.payload.type === 'string'
      ) {
        eventType = diagnosticEventType(frame.payload.type);
      }
      const frameDiagnostic = {
        ...diagnostic,
        frameType: frame.type,
        frameBytes: parsed.bytes,
        eventType,
        operation:
          frame.type === 'request' && isControlOperation(frame.operation)
            ? frame.operation
            : undefined,
        requestId: frame.type !== 'event' ? frame.requestId : undefined,
      };
      log('socket_frame_received', frameDiagnostic);
      if (frame.type === 'request' && frame.operation === 'sandbox.hello') {
        if (!isProvisionalSocket(state, ws, attachment)) {
          log('socket_frame_rejected', { ...frameDiagnostic, reason: 'invalid_provisional' });
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
          log('socket_frame_rejected', { ...frameDiagnostic, reason: 'invalid_hello' });
          sendJson(
            ws,
            errorResponse(frame.requestId, 'protocol_error', 'Invalid sandbox.hello payload')
          );
          return;
        }

        if (hooks.validateHandshake) {
          const valid = await hooks.validateHandshake(payload.providerInstanceId);
          const currentAttachment = readAttachment(ws);
          if (
            !isProvisionalSocket(state, ws, currentAttachment) ||
            currentAttachment.connectionId !== attachment.connectionId
          ) {
            return;
          }
          if (!valid) {
            log('socket_frame_rejected', {
              ...frameDiagnostic,
              reason: 'invalid_provider_instance',
            });
            sendJson(
              ws,
              errorResponse(frame.requestId, 'unauthorized', 'Invalid sandbox provider instance')
            );
            closeSocket(ws, 1008, 'invalid_provider_instance');
            return;
          }
        }

        const identity: SandboxControlConnectionIdentity = {
          connectionId: attachment.connectionId,
          providerInstanceId: payload.providerInstanceId,
          ...(payload.wrapperInstanceId ? { wrapperInstanceId: payload.wrapperInstanceId } : {}),
        };
        const completed: SandboxControlSocketAttachment = {
          handshakeComplete: true,
          kiloReady: false,
          acceptedAt: attachment.acceptedAt,
          connectionId: identity.connectionId,
          protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
          providerInstanceId: identity.providerInstanceId,
          ...(payload.capabilities ? { capabilities: payload.capabilities } : {}),
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

        observations.delete(ws);
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
          const activation = hooks.onHandshakeComplete?.(identity, {
            wrapperVersion: safeSandboxRuntimeVersion(payload.wrapperVersion),
          });
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
        log('socket_handshake_complete', { ...diagnosticConnection(identity), replaced });
        return;
      }

      if (!attachment?.handshakeComplete) {
        log('socket_frame_rejected', { ...frameDiagnostic, reason: 'handshake_required' });
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
        log('socket_frame_rejected', { ...frameDiagnostic, reason: 'stale_connection' });
        closeSocket(ws, 1008, 'stale_connection');
        return;
      }
      if (activatingConnections.has(identity.connectionId)) {
        log('socket_frame_rejected', { ...frameDiagnostic, reason: 'activation_pending' });
        return;
      }

      if (frame.type === 'response') {
        log('socket_response', { ...frameDiagnostic, ok: frame.ok });
        waiters.settle(frame);
        return;
      }

      if (frame.type === 'event') {
        if (!isControlEvent(frame.event)) {
          log('socket_frame_rejected', { ...frameDiagnostic, reason: 'unknown_event' });
          return;
        }
        const eventPayload = parseEventPayload(frame.event, frame.payload);
        if (!eventPayload.ok) {
          log('socket_frame_rejected', { ...frameDiagnostic, reason: 'invalid_event_payload' });
          return;
        }
        if (frame.event === 'sandbox.ready') {
          recordObservation(ws, true);
          await hooks.onReady?.(identity);
        } else if (frame.event === 'sandbox.heartbeat') {
          const payload = eventPayload.payload as SandboxHeartbeatPayload;
          const observation = recordObservation(ws, payload.kilo.ready);
          await hooks.onHeartbeat?.(payload, identity);
          if (observation) {
            const idle = await summarizeHeartbeatIdle(payload);
            if (isCurrentConnection(state, ws, identity) && observations.get(ws) === observation) {
              const currentAttachment = readAttachment(ws);
              if (currentAttachment) {
                ws.serializeAttachment({
                  ...currentAttachment,
                  observation: { ...observation, idle },
                });
              }
            }
          }
        } else if (frame.event === 'session.event') {
          invalidateIdleObservation(ws, attachment);
          await hooks.onSessionEvent?.(
            frame.session,
            eventPayload.payload as SessionEventPayload,
            identity
          );
        } else if (frame.event === 'session.preparing') {
          invalidateIdleObservation(ws, attachment);
          await hooks.onSessionPreparing?.(
            frame.session,
            eventPayload.payload as SessionPreparingPayload,
            identity
          );
        }
        return;
      }

      if (frame.operation === 'session.operation.result') {
        let parsedSession: SessionRequestIdentity;
        let parsedDelivery: SessionOperationDelivery;
        try {
          parsedSession = sessionRequestIdentitySchema.parse(frame.session);
          parsedDelivery = sessionOperationDeliverySchema.parse(frame.payload);
        } catch {
          sendJson(
            ws,
            errorResponse(
              frame.requestId,
              'protocol_error',
              'Invalid operation result payload',
              false
            )
          );
          return;
        }
        if (parsedDelivery.authorization.wrapperInstanceId !== identity.wrapperInstanceId) {
          sendJson(
            ws,
            errorResponse(frame.requestId, 'unauthorized', 'Operation source mismatch', false)
          );
          return;
        }
        try {
          const ack = await hooks.onOperationResult?.(parsedSession, parsedDelivery, identity);
          if (!isCurrentConnection(state, ws, identity)) return;
          sendJson(
            ws,
            ack
              ? okResponse(frame.requestId, ack)
              : errorResponse(
                  frame.requestId,
                  'not_ready',
                  'Operation result was not acknowledged',
                  true
                )
          );
        } catch (error) {
          if (isCurrentConnection(state, ws, identity)) {
            const permanent = error instanceof SandboxControlConnectionError && !error.retryable;
            try {
              sendJson(
                ws,
                errorResponse(
                  frame.requestId,
                  permanent ? 'unauthorized' : 'not_ready',
                  'Operation result delivery failed',
                  !permanent
                )
              );
            } catch {
              return;
            }
          }
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
      log('socket_closed', {
        connectionId: attachment?.connectionId,
        wrapperInstanceId: attachment?.wrapperInstanceId,
        handshakeComplete,
      });
      if (!handshakeComplete) return;

      const current = currentHandshakenSocket(state);
      if (current && current.socket !== ws) return;
      const identity = readConnectionIdentity(readAttachment(ws)) ?? undefined;
      ws.serializeAttachment({
        ...attachment,
        ...identity,
        handshakeComplete: false,
        kiloReady: false,
      });
      const remaining = state.getWebSockets(SANDBOX_CONTROL_WS_TAG).some(other => {
        if (other === ws || other.readyState !== 1) return false;
        return readAttachment(other)?.handshakeComplete === true;
      });
      if (remaining) return;

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
      const authorization = input.authorization
        ? sessionOperationAuthorizationSchema.safeParse(input.authorization)
        : undefined;
      if (
        authorization &&
        (!authorization.success ||
          (input.operation !== 'session.attach' && input.operation !== 'session.prompt') ||
          authorization.data.operation !== input.operation ||
          !input.session ||
          authorization.data.session.sessionId !== input.session.sessionId ||
          authorization.data.session.kiloSessionId !== input.session.kiloSessionId ||
          authorization.data.session.directory !== input.session.directory ||
          (input.expectedWrapperInstanceId !== undefined &&
            authorization.data.wrapperInstanceId !== input.expectedWrapperInstanceId) ||
          Date.now() >= authorization.data.dispatchDeadlineAt)
      ) {
        throw new SandboxControlConnectionError('Invalid session operation authorization', false);
      }
      if (
        isSessionOperation(input.operation) &&
        !sessionRequestIdentitySchema.safeParse(input.session).success
      ) {
        throw new Error('session identity is required');
      }

      const current = currentHandshakenSocket(state);
      const readyOnly = input.operation === 'session.git.summary';
      if (readyOnly && (!current || readAttachment(current.socket)?.kiloReady !== true)) {
        return errorResponse(crypto.randomUUID(), 'not_ready', 'No ready wrapper socket', true);
      }
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
        ...(input.authorization ? { authorization: input.authorization } : {}),
      };
      const authorizationTimeout = authorization?.success
        ? authorization.data.dispatchDeadlineAt - Date.now()
        : undefined;
      const deadlineTimeout =
        input.deadlineAt === undefined ? undefined : Math.max(1, input.deadlineAt - Date.now());
      const timeoutMs = [input.timeoutMs, authorizationTimeout, deadlineTimeout]
        .filter((timeout): timeout is number => timeout !== undefined)
        .reduce<number | undefined>(
          (shortest, timeout) => (shortest === undefined ? timeout : Math.min(shortest, timeout)),
          undefined
        );
      const pending = waiters.wait(requestId, timeoutMs);
      log('socket_request_sent', {
        ...diagnosticConnection(current.identity),
        requestId,
        operation: input.operation,
        sessionId: input.session?.sessionId,
        timeoutMs: input.timeoutMs,
      });
      sendJson(current.socket, frame);
      const response = await pending;
      if (
        readyOnly &&
        (!isCurrentConnection(state, current.socket, current.identity) ||
          readAttachment(current.socket)?.kiloReady !== true)
      ) {
        throw new SandboxControlConnectionError('Worktree capture connection changed');
      }
      return response;
    },
  };
}
