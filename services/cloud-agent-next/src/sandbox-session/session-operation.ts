import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  sessionAttachPayloadSchema,
  sessionAttachResultSchema,
  sessionOperationAuthorizationSchema,
  sessionOperationAckSchema,
  sessionOperationExpiresAt,
  sessionOperationLookupResultSchema,
  sessionPromptPayloadSchema,
  sessionPromptResultSchema,
  sameSessionOperation,
  type ResponseFrame,
  type SessionOperationAck,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type { EventQueries } from '../session/queries/index.js';
import type { StoredEvent } from '../websocket/types.js';
import {
  applySessionOperationResult,
  completeSessionOperationAttachment,
  recordSessionOperationDispatch,
  type SessionMessageRecord,
} from './session-message-queue.js';
import { persistSandboxControlSessionEvent } from './sandbox-control-event.js';
import { applyControlPlanePreparingEvent } from './control-plane-preparing.js';
import {
  ControlRequestError,
  controlRequestResult,
  withDeliveryDeadline,
} from './control-dispatch.js';

type OperationMessages = {
  read: () => SessionMessageRecord[];
  commit: (messages: SessionMessageRecord[]) => boolean;
};

export type SessionOperationEffects = {
  request: (input: SandboxControlOutboundRequest) => Promise<ResponseFrame>;
  persistResult: (delivery: SessionOperationDelivery) => Promise<SessionOperationAck | undefined>;
  isDispatchCurrent: () => boolean;
  isMaintenanceCurrent: () => boolean;
};

export type SessionOperationDispatch =
  | { state: 'response'; result: unknown }
  | { state: 'running' }
  | { state: 'completed' };

function uncertainOperation(reason: string): ControlRequestError {
  return new ControlRequestError({ code: 'runtime_unhealthy', message: reason, retryable: false });
}

export async function dispatchSessionOperation(
  input: { authorization: SessionOperationAuthorization; payload: unknown },
  messages: OperationMessages,
  effects: SessionOperationEffects
): Promise<SessionOperationDispatch> {
  const authorization = sessionOperationAuthorizationSchema.parse(input.authorization);
  const kind = authorization.operation === 'session.attach' ? 'attach' : 'prompt';
  const timeoutMs =
    kind === 'attach' ? SANDBOX_CONTROL_ATTACH_TIMEOUT_MS : SANDBOX_CONTROL_REQUEST_TIMEOUT_MS;
  const assertDispatchCurrent = () => {
    if (!effects.isDispatchCurrent() || Date.now() >= authorization.dispatchDeadlineAt)
      throw uncertainOperation('Session operation dispatch authority expired');
  };
  const assertMaintenanceCurrent = () => {
    if (!effects.isMaintenanceCurrent() || Date.now() >= sessionOperationExpiresAt(authorization))
      throw uncertainOperation('Session operation maintenance authority expired');
  };
  const existing = messages.read().find(message => message.messageId === authorization.messageId);
  const proof = existing?.operations?.[kind];
  if (
    proof &&
    !sameSessionOperation(
      sessionOperationAuthorizationSchema.parse(proof.authorization),
      authorization
    )
  )
    throw uncertainOperation('Session operation authorization changed');

  if (proof?.dispatched) {
    assertMaintenanceCurrent();
    const lookup = sessionOperationLookupResultSchema.parse(
      controlRequestResult(
        await withDeliveryDeadline(
          () =>
            effects.request({
              operation: 'session.operation.get',
              session: authorization.session,
              payload: authorization,
              expectedWrapperInstanceId: authorization.wrapperInstanceId,
              deadlineAt: sessionOperationExpiresAt(authorization),
              timeoutMs: SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
            }),
          sessionOperationExpiresAt(authorization),
          SANDBOX_CONTROL_REQUEST_TIMEOUT_MS
        )
      )
    );
    assertMaintenanceCurrent();
    if (lookup.state === 'missing')
      throw uncertainOperation('Original session operation is missing');
    if (lookup.state === 'running') {
      if (!sameSessionOperation(lookup.authorization, authorization))
        throw uncertainOperation('Original session operation identity changed');
      return { state: 'running' };
    }
    if (!sameSessionOperation(lookup.delivery.authorization, authorization))
      throw uncertainOperation('Original session operation identity changed');
    const ack = await effects.persistResult(lookup.delivery);
    if (!ack) throw uncertainOperation('Original session operation result was not verified');
    assertMaintenanceCurrent();
    controlRequestResult(
      await withDeliveryDeadline(
        () =>
          effects.request({
            operation: 'session.operation.ack',
            session: authorization.session,
            payload: ack,
            expectedWrapperInstanceId: authorization.wrapperInstanceId,
            deadlineAt: Math.min(
              sessionOperationExpiresAt(authorization),
              lookup.delivery.completedAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS
            ),
            timeoutMs: SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
          }),
        Math.min(
          sessionOperationExpiresAt(authorization),
          lookup.delivery.completedAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS
        ),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS
      )
    );
    if (kind === 'attach') {
      const attached = sessionAttachResultSchema.safeParse(
        lookup.delivery.result.ok ? lookup.delivery.result.result : undefined
      );
      if (!attached.success) throw uncertainOperation('Original attachment result is invalid');
      const completed = completeSessionOperationAttachment(messages.read(), authorization);
      if (!completed || !messages.commit(completed))
        throw uncertainOperation('Original attachment result was not persisted');
      return { state: 'response', result: attached.data };
    }
    return { state: 'completed' };
  }

  const payload =
    kind === 'attach'
      ? sessionAttachPayloadSchema.parse(input.payload)
      : sessionPromptPayloadSchema.parse(input.payload);
  assertDispatchCurrent();
  const recorded = recordSessionOperationDispatch(messages.read(), authorization);
  if (!recorded || !messages.commit(recorded))
    throw uncertainOperation('Session operation dispatch proof was not persisted');
  assertDispatchCurrent();
  const result = controlRequestResult(
    await withDeliveryDeadline(
      () =>
        effects.request({
          operation: authorization.operation,
          authorization,
          session: authorization.session,
          expectedWrapperInstanceId: authorization.wrapperInstanceId,
          payload,
          deadlineAt: authorization.dispatchDeadlineAt,
          timeoutMs,
        }),
      authorization.dispatchDeadlineAt,
      timeoutMs
    )
  );
  assertDispatchCurrent();
  if (kind === 'attach') {
    const attached = sessionAttachResultSchema.parse(result);
    const completed = completeSessionOperationAttachment(messages.read(), authorization);
    if (!completed || !messages.commit(completed))
      throw uncertainOperation('Session attachment response was not persisted');
    return { state: 'response', result: attached };
  }
  const prompt = sessionPromptResultSchema.parse(result);
  if (prompt.messageId !== authorization.messageId)
    throw uncertainOperation('Prompt response message identity mismatch');
  return { state: 'response', result: prompt };
}

export function commitSessionOperationResult(input: {
  storage: Pick<DurableObjectStorage, 'transactionSync'>;
  delivery: SessionOperationDelivery;
  hash: string;
  deadlineAt: number;
  isCurrent: () => boolean;
  messages: OperationMessages;
  eventQueries?: EventQueries;
  notifications: StoredEvent[];
}): SessionOperationAck | undefined {
  const { delivery, messages, notifications } = input;
  const authorization = delivery.authorization;
  const committedNotifications: StoredEvent[] = [];
  const acknowledgement = input.storage.transactionSync(() => {
    if (!input.isCurrent() || Date.now() >= sessionOperationExpiresAt(authorization)) return;
    const current = messages.read();
    const message = current.find(item => item.messageId === authorization.messageId);
    if (
      Date.now() >= input.deadlineAt &&
      (message?.state === 'queued' || message?.state === 'accepted')
    )
      return;
    const applied = applySessionOperationResult(current, delivery, input.hash, Date.now());
    if (!applied) return;
    if (applied.disposition === 'applied') {
      if (input.eventQueries) {
        for (const payload of delivery.events)
          persistSandboxControlSessionEvent({
            sessionId: authorization.session.sessionId,
            payload,
            eventQueries: input.eventQueries,
            broadcast: event => committedNotifications.push(event),
          });
        for (const data of delivery.preparing)
          applyControlPlanePreparingEvent({
            sessionId: authorization.session.sessionId,
            data,
            eventQueries: input.eventQueries,
            broadcast: event => committedNotifications.push(event),
          });
      }
      if (!messages.commit(applied.messages)) throw new Error('Operation result was not persisted');
    }
    return sessionOperationAckSchema.parse({
      version: 2,
      authorization,
      resultHash: input.hash,
      disposition: applied.disposition,
      decision: applied.decision,
    });
  });
  if (acknowledgement) notifications.push(...committedNotifications);
  return acknowledgement;
}
