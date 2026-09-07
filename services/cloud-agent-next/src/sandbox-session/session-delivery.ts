import type { DORetryScope } from '@kilocode/worker-utils';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import {
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  type ResponseFrame,
  type SessionOperationAck,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import { controlRequestResult, withDeliveryDeadline } from './control-dispatch.js';

export type SessionOperationDeliveryEffects = {
  request: (input: SandboxControlOutboundRequest, scope: DORetryScope) => Promise<ResponseFrame>;
  persistResult: (delivery: SessionOperationDelivery) => Promise<SessionOperationAck | undefined>;
  assertScope: () => void;
  defer: (pending: Promise<void>) => void;
};

export async function persistSessionOperationDelivery(
  delivery: SessionOperationDelivery,
  operationDeadlineAt: number,
  effects: SessionOperationDeliveryEffects
): Promise<'persisted' | 'unverified'> {
  const acknowledgement = await effects.persistResult(delivery);
  if (!acknowledgement) return 'unverified';
  const acknowledgementDeadlineAt = Math.min(
    operationDeadlineAt,
    delivery.completedAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS
  );
  if (Date.now() >= acknowledgementDeadlineAt) return 'persisted';
  effects.defer(
    withDeliveryDeadline(async () => {
      effects.assertScope();
      controlRequestResult(
        await effects.request(
          {
            operation: 'session.operation.ack',
            session: delivery.authorization.session,
            payload: acknowledgement,
            expectedWrapperInstanceId: delivery.authorization.wrapperInstanceId,
            deadlineAt: acknowledgementDeadlineAt,
          },
          { deadlineAt: acknowledgementDeadlineAt, assertCurrent: effects.assertScope }
        )
      );
    }, acknowledgementDeadlineAt).catch(() => undefined)
  );
  return 'persisted';
}
