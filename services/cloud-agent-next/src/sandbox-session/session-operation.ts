import type { DORetryScope } from '@kilocode/worker-utils';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type { EventQueries } from '../session/queries/index.js';
import type { StoredEvent } from '../websocket/types.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  sameSessionOperation,
  sessionAttachPayloadSchema,
  sessionAttachResultSchema,
  sessionOperationAckSchema,
  sessionOperationAuthorizationSchema,
  sessionOperationExpiresAt,
  sessionOperationLookupResultSchema,
  sessionPromptPayloadSchema,
  sessionPromptResultSchema,
  type ControlError,
  type ResponseFrame,
  type SessionOperationAck,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import {
  applySessionOperationResult,
  completeSessionOperationAttachment,
  recordSessionOperationDispatch,
  recordSessionOperationExecutionDeadline,
  type SessionMessageRecord,
} from './session-message-queue.js';
import { applyControlPlanePreparingEvent } from './control-plane-preparing.js';
import { persistSandboxControlSessionEvent } from './sandbox-control-event.js';
import {
  ControlRequestError,
  controlRequestResult,
  withDeliveryDeadline,
} from './control-dispatch.js';
import { persistSessionOperationDelivery } from './session-delivery.js';

type OperationMessages = {
  read: () => SessionMessageRecord[];
  commit: (messages: SessionMessageRecord[]) => boolean;
};

export type SessionOperationEffects = {
  request: (input: SandboxControlOutboundRequest, scope: DORetryScope) => Promise<ResponseFrame>;
  persistResult: (delivery: SessionOperationDelivery) => Promise<SessionOperationAck | undefined>;
  assertAdmission: () => void;
  assertScope: () => void;
  defer: (pending: Promise<void>) => void;
  recordExecutionDeadline?: (
    authorization: SessionOperationAuthorization,
    executionDeadlineAt: number
  ) => boolean;
};

type RunningOperation = Extract<
  ReturnType<typeof sessionOperationLookupResultSchema.parse>,
  { state: 'running' }
>;
type CompletedOperation = Extract<
  ReturnType<typeof sessionOperationLookupResultSchema.parse>,
  { state: 'completed' }
>;
type UncertainOperation = {
  state: 'uncertain';
  reason: 'missing' | 'unverified' | 'transport';
  error?: unknown;
};
type RejectedOperation = { state: 'rejected'; error: ControlError };
export type SessionOperationObservation =
  | RunningOperation
  | CompletedOperation
  | UncertainOperation
  | RejectedOperation;
export type SessionOperationDispatch =
  | { state: 'response'; result: unknown }
  | { state: 'completed'; result: unknown }
  | RunningOperation
  | UncertainOperation
  | RejectedOperation;

function rejectedOrUncertain(error: unknown): RejectedOperation | UncertainOperation {
  return error instanceof ControlRequestError
    ? {
        state: 'rejected',
        error: { code: error.code, message: error.message, retryable: error.retryable },
      }
    : { state: 'uncertain', reason: 'transport', error };
}

function rejectedBeforeAdmission(error: unknown): error is ControlRequestError {
  return error instanceof ControlRequestError && error.admission === 'not-admitted';
}

export async function reconcileSessionOperation(
  original: SessionOperationAuthorization,
  deadlineAt: number,
  effects: SessionOperationEffects
): Promise<SessionOperationObservation> {
  const authorization = sessionOperationAuthorizationSchema.parse(original);
  const operationDeadlineAt = Math.min(deadlineAt, sessionOperationExpiresAt(authorization));
  const scope = { deadlineAt: operationDeadlineAt, assertCurrent: effects.assertScope };
  try {
    effects.assertScope();
    const response = await withDeliveryDeadline(
      () =>
        effects.request(
          {
            operation: 'session.operation.get',
            session: authorization.session,
            payload: authorization,
            expectedWrapperInstanceId: authorization.wrapperInstanceId,
            timeoutMs: Math.max(
              1,
              Math.min(SANDBOX_CONTROL_REQUEST_TIMEOUT_MS, operationDeadlineAt - Date.now())
            ),
            deadlineAt: operationDeadlineAt,
          },
          scope
        ),
      operationDeadlineAt
    );
    effects.assertScope();
    if (Date.now() >= operationDeadlineAt) throw new Error('Operation observation expired');
    const lookup = sessionOperationLookupResultSchema.parse(controlRequestResult(response));
    if (lookup.state === 'missing') return { state: 'uncertain', reason: 'missing' };
    const observed =
      lookup.state === 'completed' ? lookup.delivery.authorization : lookup.authorization;
    if (!sameSessionOperation(observed, authorization))
      throw new Error('Operation observation identity changed');
    if (
      lookup.state === 'running' &&
      lookup.executionDeadlineAt !== undefined &&
      effects.recordExecutionDeadline?.(authorization, lookup.executionDeadlineAt) === false
    )
      return { state: 'uncertain', reason: 'unverified' };
    if (lookup.state === 'completed') {
      if (
        (await persistSessionOperationDelivery(lookup.delivery, operationDeadlineAt, effects)) ===
        'unverified'
      )
        return { state: 'uncertain', reason: 'unverified' };
    }
    return lookup;
  } catch (error) {
    return rejectedOrUncertain(error);
  }
}

export async function dispatchSessionOperation(
  input: { authorization: SessionOperationAuthorization; payload: unknown },
  messages: OperationMessages,
  effects: SessionOperationEffects & { isCurrent: () => boolean }
): Promise<SessionOperationDispatch> {
  const authorization = sessionOperationAuthorizationSchema.parse(input.authorization);
  const kind = authorization.operation === 'session.attach' ? 'attach' : 'prompt';
  const deadlineAt = authorization.dispatchDeadlineAt;
  const current = () => effects.isCurrent() && Date.now() < deadlineAt;
  const assertAdmissionCurrent = () => {
    effects.assertAdmission();
    if (!current()) throw new Error('Session delivery is no longer authorized');
  };
  const assertDispatchedCurrent = () => {
    effects.assertScope();
    if (!current()) throw new Error('Session delivery is no longer authorized');
  };
  const record = (dispatched: boolean) => {
    if (!current()) return false;
    const next = recordSessionOperationDispatch(messages.read(), authorization, dispatched);
    return next !== undefined && messages.commit(next);
  };
  try {
    const message = messages.read().find(item => item.messageId === authorization.messageId);
    const proof = message?.operations?.[kind];
    if (proof && !sameSessionOperation(proof.authorization, authorization))
      throw new Error('Original operation authorization changed');
    if (proof?.dispatched) {
      effects.assertScope();
      const lookup = await reconcileSessionOperation(
        authorization,
        sessionOperationExpiresAt(authorization),
        {
          ...effects,
          recordExecutionDeadline: (original, executionDeadlineAt) => {
            const updated = recordSessionOperationExecutionDeadline(
              messages.read(),
              original,
              executionDeadlineAt
            );
            return updated !== undefined && messages.commit(updated);
          },
        }
      );
      if (lookup.state !== 'completed') return lookup;
      if (!lookup.delivery.result.ok)
        return { state: 'rejected', error: lookup.delivery.result.error };
      if (kind === 'attach') {
        const completed = completeSessionOperationAttachment(messages.read(), authorization);
        if (!completed || !messages.commit(completed))
          return { state: 'uncertain', reason: 'unverified' };
      }
      return { state: 'completed', result: lookup.delivery.result.result };
    }
    assertAdmissionCurrent();
    const payload = structuredClone(
      kind === 'attach'
        ? sessionAttachPayloadSchema.parse(input.payload)
        : sessionPromptPayloadSchema.parse(input.payload)
    );
    if (!record(true)) throw new Error('Session operation proof could not be persisted');
    assertDispatchedCurrent();
    try {
      const timeoutMs =
        kind === 'attach' ? SANDBOX_CONTROL_ATTACH_TIMEOUT_MS : SANDBOX_CONTROL_REQUEST_TIMEOUT_MS;
      const response = await withDeliveryDeadline(
        () =>
          effects.request(
            {
              operation: authorization.operation,
              authorization,
              session: authorization.session,
              expectedWrapperInstanceId: authorization.wrapperInstanceId,
              payload,
              timeoutMs,
              deadlineAt,
            },
            { deadlineAt, assertCurrent: assertDispatchedCurrent }
          ),
        deadlineAt,
        timeoutMs
      );
      const result = controlRequestResult(response);
      assertDispatchedCurrent();
      if (kind === 'attach') {
        const attached = sessionAttachResultSchema.parse(result);
        const completed = completeSessionOperationAttachment(messages.read(), authorization);
        if (!completed || !messages.commit(completed))
          return { state: 'uncertain', reason: 'unverified' };
        return { state: 'response', result: attached };
      }
      const prompt = sessionPromptResultSchema.parse(result);
      if (prompt.messageId !== authorization.messageId)
        throw new Error('Prompt response message identity mismatch');
      if (prompt.executionDeadlineAt !== undefined) {
        const updated = recordSessionOperationExecutionDeadline(
          messages.read(),
          authorization,
          prompt.executionDeadlineAt
        );
        if (!updated || !messages.commit(updated))
          return { state: 'uncertain', reason: 'unverified' };
      }
      return { state: 'response', result: prompt };
    } catch (error) {
      if (rejectedBeforeAdmission(error)) record(false);
      return rejectedOrUncertain(error);
    }
  } catch (error) {
    return rejectedOrUncertain(error);
  }
}

export function operationDispatchError(
  result: Exclude<SessionOperationDispatch, { state: 'response' } | { state: 'completed' }>
): ControlRequestError {
  if (result.state === 'rejected') return new ControlRequestError(result.error);
  if (result.state === 'running')
    return new ControlRequestError({
      code: 'session_busy',
      message: 'Original preparation is running',
      retryable: true,
    });
  return new ControlRequestError({
    code: 'runtime_unhealthy',
    message:
      result.reason === 'transport'
        ? 'Operation admission acknowledgement is unconfirmed'
        : 'Original operation outcome is unconfirmed',
    retryable: result.reason === 'transport',
  });
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
