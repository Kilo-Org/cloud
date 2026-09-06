import {
  sameSessionOperation,
  sessionOperationAuthorizationSchema,
  type SessionAbortResult,
  type SessionOperationAck,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import type { SessionMessageRecord } from './session-message-queue.js';
import { expireSessionStop, settleSessionStop, type PersistedSessionStop } from './session-stop.js';

function isTerminal(message: SessionMessageRecord | undefined): boolean {
  return (
    message?.state === 'completed' || message?.state === 'failed' || message?.state === 'cancelled'
  );
}

function isCompletedDeliveredTarget(input: {
  stop: PersistedSessionStop;
  target: PersistedSessionStop['targets'][number];
  message: SessionMessageRecord | undefined;
  delivery: SessionOperationDelivery;
  acknowledgement: SessionOperationAck | undefined;
}): boolean {
  const { stop, target, message, delivery, acknowledgement } = input;
  const requestedTarget = stop.request.targets.find(item => item.messageId === target.messageId);
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(
    message?.operations?.prompt?.authorization
  );
  return (
    requestedTarget !== undefined &&
    delivery.authorization.operation === 'session.prompt' &&
    delivery.authorization.messageId === target.messageId &&
    delivery.authorization.wrapperInstanceId === requestedTarget.wrapperInstanceId &&
    storedAuthorization.success &&
    sameSessionOperation(storedAuthorization.data, delivery.authorization) &&
    delivery.result.ok &&
    delivery.outcome?.status === 'completed' &&
    acknowledgement !== undefined &&
    sameSessionOperation(acknowledgement.authorization, delivery.authorization) &&
    (acknowledgement.disposition === 'applied' || acknowledgement.disposition === 'identical') &&
    acknowledgement.decision.state === 'completed'
  );
}

export async function progressSessionStop(input: {
  stop: PersistedSessionStop;
  now: () => number;
  readMessages: () => SessionMessageRecord[];
  saveMessages: (messages: SessionMessageRecord[]) => boolean;
  abort: (target: PersistedSessionStop['targets'][number]) => Promise<SessionAbortResult>;
  applyDelivery: (
    delivery: SessionAbortResult['delivery']
  ) => Promise<SessionOperationAck | undefined>;
}): Promise<PersistedSessionStop> {
  let stop = input.stop;
  for (const target of stop.targets) {
    const message = input.readMessages().find(item => item.messageId === target.messageId);
    const awaitingCancellation =
      target.state === 'pending' &&
      message?.cancellation?.operationId === stop.request.operationId &&
      message.wrapperInstanceId !== undefined;
    if ((isTerminal(message) && !awaitingCancellation) || !message?.cancellation) {
      stop = settleSessionStop(stop, target.messageId);
      continue;
    }
    if (target.state === 'confirmed' || input.now() >= stop.request.cleanupDeadlineAt) continue;
    try {
      const result = await input.abort(target);
      const acknowledgement = result.delivery
        ? await input.applyDelivery(result.delivery)
        : undefined;
      const current = input.readMessages().find(item => item.messageId === target.messageId);
      if (
        result.delivery &&
        isCompletedDeliveredTarget({
          stop,
          target,
          message: current,
          delivery: result.delivery,
          acknowledgement,
        })
      ) {
        stop = settleSessionStop(stop, target.messageId);
        continue;
      }
      if (
        result.quiescent === true &&
        current?.state === 'accepted' &&
        current.cancellation?.operationId === stop.request.operationId
      ) {
        input.saveMessages(
          input.readMessages().map(message =>
            message.messageId === target.messageId && message.state === 'accepted'
              ? {
                  ...message,
                  state: 'cancelled',
                  terminalAt: input.now(),
                  terminalSource: 'coordinator',
                }
              : message
          )
        );
      }
      if (
        result.quiescent === true &&
        isTerminal(input.readMessages().find(item => item.messageId === target.messageId))
      ) {
        stop = settleSessionStop(stop, target.messageId);
      }
    } catch {
      continue;
    }
  }
  const expired = expireSessionStop(stop, input.now());
  if (expired.state === 'unconfirmed' && stop.state === 'accepted') {
    input.saveMessages(
      input.readMessages().map(message =>
        message.state === 'accepted' &&
        message.cancellation?.operationId === stop.request.operationId
          ? {
              ...message,
              state: 'failed',
              failedReason: 'interruption_unconfirmed',
              terminalAt: input.now(),
              terminalSource: 'coordinator',
            }
          : message
      )
    );
  }
  return expired;
}
