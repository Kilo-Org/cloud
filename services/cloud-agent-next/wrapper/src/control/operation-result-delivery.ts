import { setTimeout as delay } from 'node:timers/promises';
import {
  SANDBOX_CONTROL_OUTCOME_RETRY_MS,
  SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS,
  sameSessionOperation,
  sessionOperationAckSchema,
  sessionOperationExpiresAt,
  sessionOperationResultHash,
  type SessionOperationAck,
  type SessionOperationDelivery,
} from '../../../src/shared/sandbox-control-protocol.js';
import { withTimeoutAndAbort } from '../utils.js';

export type OperationResultSender = (
  delivery: SessionOperationDelivery,
  signal: AbortSignal,
  deadlineAt: number
) => Promise<SessionOperationAck>;

export function createOperationResultDelivery(
  result: SessionOperationDelivery,
  deadlineAt: number,
  send?: OperationResultSender
) {
  const payload = structuredClone(result);
  let state: 'pending' | 'acknowledged' | 'exhausted' = 'pending';
  let acknowledgement: SessionOperationAck | undefined;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;

  async function acknowledge(ack: SessionOperationAck, isCurrent: () => boolean): Promise<boolean> {
    if (
      !sameSessionOperation(payload.authorization, ack.authorization) ||
      Date.now() >= sessionOperationExpiresAt(payload.authorization)
    )
      return false;
    const hash = await sessionOperationResultHash(payload);
    if (
      !isCurrent() ||
      Date.now() >= sessionOperationExpiresAt(payload.authorization) ||
      hash !== ack.resultHash
    )
      return false;
    acknowledgement = structuredClone(ack);
    state = 'acknowledged';
    controller?.abort();
    return true;
  }

  async function deliver(): Promise<void> {
    if (state !== 'pending' || !send) return;
    const deliveryController = new AbortController();
    controller = deliveryController;
    const signal = deliveryController.signal;
    const timeout = setTimeout(
      () => deliveryController.abort(),
      Math.max(0, deadlineAt - Date.now())
    );
    timeout.unref();
    try {
      const hash = await sessionOperationResultHash(payload);
      for (let attempt = 0; attempt < SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS; attempt++) {
        if (signal.aborted || Date.now() >= deadlineAt) break;
        try {
          const ack = sessionOperationAckSchema.parse(
            await withTimeoutAndAbort(send(structuredClone(payload), signal, deadlineAt), {
              signal,
              timeoutMs: Math.max(1, deadlineAt - Date.now()),
              timeoutMessage: 'Operation result delivery expired',
              abortMessage: 'Operation result delivery cancelled',
            })
          );
          if (
            !signal.aborted &&
            Date.now() < deadlineAt &&
            sameSessionOperation(ack.authorization, payload.authorization) &&
            ack.resultHash === hash
          ) {
            acknowledgement = ack;
            state = 'acknowledged';
            return;
          }
        } catch (error: unknown) {
          if (signal.aborted) break;
          if (
            error instanceof Error &&
            'retryable' in error &&
            (error as { retryable: boolean }).retryable === false
          )
            break;
        }
        if (attempt + 1 < SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS) {
          await delay(
            Math.min(
              SANDBOX_CONTROL_OUTCOME_RETRY_MS * 2 ** attempt,
              Math.max(0, deadlineAt - Date.now())
            ),
            undefined,
            { signal }
          );
        }
      }
      if (acknowledgement === undefined && Date.now() < deadlineAt)
        await delay(deadlineAt - Date.now(), undefined, { signal });
    } catch {
      if (acknowledgement === undefined) state = 'exhausted';
    } finally {
      clearTimeout(timeout);
      deliveryController.abort();
      if (controller === deliveryController) controller = undefined;
      if (acknowledgement === undefined) state = 'exhausted';
    }
  }

  return {
    start(): Promise<void> {
      pending ??= Promise.resolve().then(deliver);
      return pending;
    },
    acknowledge,
    status: () => ({ state, deadlineAt }),
    result: () => structuredClone(payload),
    snapshot: () => ({
      payload: structuredClone(payload),
      deadlineAt,
      state,
      acknowledgement: acknowledgement ? structuredClone(acknowledgement) : undefined,
    }),
    drain: () => pending ?? Promise.resolve(),
  };
}

export type OperationResultDelivery = ReturnType<typeof createOperationResultDelivery>;
