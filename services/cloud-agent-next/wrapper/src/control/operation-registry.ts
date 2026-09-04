import { isDeepStrictEqual } from 'node:util';
import {
  SANDBOX_CONTROL_OPERATION_LIMIT,
  sessionOperationAuthorizationSchema,
  sessionOperationAckSchema,
  sessionOperationExpiresAt,
  type SessionOperationAuthorization,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { rejectBeforeAdmission } from './control-handler-result.js';
import type { WorktreeKiloRuntimes } from './worktree-runtime.js';
import {
  SessionOperation,
  type ControlHandlerResult,
  type SessionOperationDependencies,
  type SessionOperationWork,
} from './session-operation.js';

type OperationRegistryDependencies = {
  native: Pick<WorktreeKiloRuntimes, 'get'>;
  onStarted: (session: SessionRequestIdentity, preparation: boolean) => void;
  onCompleted: (session: SessionRequestIdentity) => void;
  retireRuntime: (reason: string) => void;
};

type OperationEffects = Pick<
  SessionOperationDependencies,
  'signal' | 'emitSessionEvent' | 'sendOperationResult' | 'onDiagnostic'
>;

type Admission =
  | { kind: 'continue' }
  | { kind: 'reply'; result: ControlHandlerResult | Promise<ControlHandlerResult> };

function key(authorization: SessionOperationAuthorization): string {
  return JSON.stringify([
    authorization.session.sessionId,
    authorization.operation,
    authorization.operationId,
  ]);
}

function ok(result: unknown): ControlHandlerResult {
  return { ok: true, result };
}

function fail(code: string, message: string, retryable: boolean): ControlHandlerResult {
  return { ok: false, error: { code, message, retryable } };
}

export function createOperationRegistry(deps: OperationRegistryDependencies) {
  const active = new Map<string, SessionOperation>();
  const retained = new Map<string, SessionOperation>();

  function prune(now = Date.now()): void {
    for (const [id, operation] of retained) {
      if (!operation.canPrune(now)) continue;
      retained.delete(id);
    }
  }

  function admission(
    operation: string,
    session: SessionRequestIdentity,
    payload: unknown,
    authorization?: SessionOperationAuthorization
  ): Admission {
    if (operation !== 'session.operation.get' && !authorization) return { kind: 'continue' };
    const reply = (result: ControlHandlerResult | Promise<ControlHandlerResult>): Admission => ({
      kind: 'reply',
      result,
    });
    const parsed = sessionOperationAuthorizationSchema.safeParse(
      operation === 'session.operation.get' ? payload : authorization
    );
    if (!parsed.success)
      return reply(
        rejectBeforeAdmission('protocol_error', 'Invalid operation authorization', false)
      );
    const target = parsed.data;
    if (!isDeepStrictEqual(target.session, session))
      return reply(rejectBeforeAdmission('unauthorized', 'Operation target mismatch', false));
    if (operation !== 'session.operation.get' && target.operation !== operation)
      return reply(
        rejectBeforeAdmission('unauthorized', 'Operation authorization mismatch', false)
      );
    if (Date.now() >= sessionOperationExpiresAt(target))
      return reply(rejectBeforeAdmission('not_ready', 'Operation authorization expired', false));
    prune();
    const existing = retained.get(key(target));
    if (existing) {
      if (!existing.matchesAuthorization(target) || !isDeepStrictEqual(existing.session, session))
        return reply(
          rejectBeforeAdmission('idempotency_conflict', 'Operation identity mismatch', false)
        );
      if (operation === 'session.operation.get') {
        const delivery = existing.deliveryResult();
        return reply(
          ok(
            delivery
              ? { state: 'completed', delivery }
              : {
                  state: 'running',
                  authorization: target,
                }
          )
        );
      }
      try {
        if (!existing.matchesIntent(payload))
          return reply(
            rejectBeforeAdmission('idempotency_conflict', 'Operation intent mismatch', false)
          );
      } catch {
        return reply(rejectBeforeAdmission('protocol_error', 'Invalid payload', false));
      }
      return reply(
        operation === 'session.attach'
          ? existing.done
          : ok({ messageId: target.messageId, status: 'existing' })
      );
    }
    if (operation === 'session.operation.get') return reply(ok({ state: 'missing' }));
    if (Date.now() >= target.dispatchDeadlineAt)
      return reply(
        rejectBeforeAdmission('not_ready', 'Operation dispatch authorization expired', false)
      );
    if (retained.size >= SANDBOX_CONTROL_OPERATION_LIMIT)
      return reply(
        rejectBeforeAdmission('session_busy', 'Operation receipt capacity is unavailable', true)
      );
    return { kind: 'continue' };
  }

  async function acknowledge(
    session: SessionRequestIdentity,
    payload: unknown
  ): Promise<ControlHandlerResult> {
    const parsed = sessionOperationAckSchema.safeParse(payload);
    if (!parsed.success || !isDeepStrictEqual(parsed.data.authorization.session, session))
      return fail('unauthorized', 'Invalid operation acknowledgement', false);
    const id = key(parsed.data.authorization);
    const operation = retained.get(id);
    if (!operation) return fail('unauthorized', 'Operation acknowledgement is not current', false);
    return (await operation.acknowledge(parsed.data, () => retained.get(id) === operation))
      ? ok({ acknowledged: true })
      : fail('unauthorized', 'Operation acknowledgement does not match the result', false);
  }

  function start(
    session: SessionRequestIdentity,
    authorization: SessionOperationAuthorization | undefined,
    work: SessionOperationWork,
    effects: OperationEffects
  ): SessionOperation {
    const identity = Object.freeze({ ...session });
    const operation = new SessionOperation(identity, authorization, work, {
      ...effects,
      isCurrent: () => active.get(identity.kiloSessionId) === operation,
      getRuntime: () => deps.native.get(identity.directory),
      retireRuntime: reason => deps.retireRuntime(reason),
      onLocalCompletion: retain => {
        if (active.get(identity.kiloSessionId) === operation) {
          active.delete(identity.kiloSessionId);
          deps.onCompleted(identity);
        }
        if (authorization && !retain && retained.get(key(authorization)) === operation)
          retained.delete(key(authorization));
      },
    });
    if (authorization) retained.set(key(authorization), operation);
    active.set(identity.kiloSessionId, operation);
    deps.onStarted(identity, work.operation === 'session.attach');
    return operation;
  }

  return {
    admission,
    acknowledge,
    start,
    prune,
    active: (rootKiloSessionId: string) => active.get(rootKiloSessionId),
    hasActive: (rootKiloSessionId: string) => active.has(rootKiloSessionId),
    activeOperations: () => [...active.values()],
    retained: () => [...retained.values()],
    counts: () => ({ active: active.size, retained: retained.size }),
    async drainDelivery(deadlineAt: number): Promise<void> {
      const timeout = Math.max(0, deadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...retained.values()].map(operation => operation.waitForDelivery())),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, timeout);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export type OperationRegistry = ReturnType<typeof createOperationRegistry>;
