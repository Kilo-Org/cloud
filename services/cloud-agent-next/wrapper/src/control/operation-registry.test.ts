import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OWNED_PROCESS_CLEANUP_UNREAPED,
  type ControlDiagnosticFields,
} from '../../../src/shared/control-diagnostics';
import {
  SANDBOX_CONTROL_OPERATION_LIMIT,
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  sessionOperationLookupResultSchema,
} from '../../../src/shared/sandbox-control-protocol';
import {
  createControlHandlerDeps,
  handleControlRequest,
  pruneControlOperations,
  type HandlerDeps,
} from './sandbox-control-handlers';
import {
  acknowledgeOperation,
  completion,
  createHandlerFixture,
  fakeKilo,
  kilo,
  operationAuthorization,
  promptPayload,
  session,
  type Completion,
} from './control-test-fixtures';
import { operationIntent } from './operation-intent';
import {
  rememberAttachedRoot,
  rememberChildSession,
  resetSessionDirectoryState,
} from './session-directories';
import { createOperationRegistry } from './operation-registry';
import { resetDirectoryOperationState } from './worktree-operations';

let homeRoot: string;

beforeEach(() => {
  resetSessionDirectoryState();
  resetDirectoryOperationState();
  rememberAttachedRoot(session.kiloSessionId, session.directory);
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-registry-test-'));
});

afterEach(() => {
  setSystemTime();
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

function deps(overrides: Parameters<typeof createHandlerFixture>[1] = {}): HandlerDeps {
  return createHandlerFixture(homeRoot, overrides);
}

function onlyOperation(handlerDeps: HandlerDeps) {
  const records = handlerDeps.operations.retained();
  expect(records).toHaveLength(1);
  const record = records[0];
  if (!record) throw new Error('Missing operation record');
  return record;
}

describe('operation admission and lookup', () => {
  it('scopes a confirmed publication failure to A and keeps B plus fresh A work live', async () => {
    const pendingA = Promise.withResolvers<Completion>();
    const pendingB = Promise.withResolvers<Completion>();
    let statusCalls = 0;
    let abortCalls = 0;
    const retired = mock();
    const client = fakeKilo({
      sendPrompt: async options =>
        options.messageId === 'message_a' ? pendingA.promise : pendingB.promise,
      abortSession: async () => {
        abortCalls += 1;
        return true;
      },
      getSessionStatuses: async () => {
        statusCalls += 1;
        return { kilo_a: { type: 'idle' } };
      },
    });
    const handlerDeps = deps({ kiloClient: client, retireRuntime: retired });
    const sessionA = { ...session, sessionId: 'ses_a', kiloSessionId: 'kilo_a' };
    const sessionB = { ...session, sessionId: 'ses_b', kiloSessionId: 'kilo_b' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    rememberAttachedRoot(sessionB.kiloSessionId, sessionB.directory);
    const authorizationA = operationAuthorization('session.prompt', 'message_a', sessionA);
    const requestA = handleControlRequest(
      'session.prompt',
      sessionA,
      { ...promptPayload, messageId: 'message_a' },
      handlerDeps,
      authorizationA
    );
    const requestB = handleControlRequest(
      'session.prompt',
      sessionB,
      { ...promptPayload, messageId: 'message_b' },
      handlerDeps
    );
    try {
      for (let index = 0; index < 10; index += 1) {
        if (
          handlerDeps.operations.active(sessionA.kiloSessionId)?.snapshot().native.state ===
          'pending'
        )
          break;
        await Promise.resolve();
      }
      for (let index = 0; index < 10; index += 1) {
        if (
          handlerDeps.operations.active(sessionB.kiloSessionId)?.snapshot().native.state ===
          'pending'
        )
          break;
        await Promise.resolve();
      }
      const runtime = handlerDeps.kiloRuntimes?.get(sessionA.directory);
      if (!runtime) throw new Error('Missing native runtime');
      const publicationCleanup = await handlerDeps.operations.retireRootPublication({
        directory: sessionA.directory,
        root: sessionA.kiloSessionId,
        nativeRuntimeId: runtime.runtimeId,
        target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
        reason: 'event rejected',
        deadlineAt: Date.now() + 1_000,
      });
      expect(publicationCleanup).toBe('confirmed');
      expect(abortCalls).toBe(1);
      expect(statusCalls).toBe(1);
      expect(handlerDeps.operations.active(sessionB.kiloSessionId)?.signal.aborted).toBe(false);
      expect(retired).not.toHaveBeenCalled();

      pendingA.resolve(completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } }));
      await requestA;
      for (
        let index = 0;
        index < 10 && handlerDeps.operations.active(sessionA.kiloSessionId);
        index += 1
      )
        await Promise.resolve();
      expect(handlerDeps.operations.active(sessionB.kiloSessionId)?.signal.aborted).toBe(false);

      pendingB.resolve(completion());
      expect((await requestB).ok).toBe(true);
      expect(await handleControlRequest('session.detach', sessionB, {}, handlerDeps)).toMatchObject(
        {
          ok: true,
          result: { detached: true },
        }
      );
      const fresh = await handleControlRequest(
        'session.prompt',
        sessionA,
        { ...promptPayload, messageId: 'message_fresh' },
        handlerDeps,
        operationAuthorization('session.prompt', 'message_fresh', sessionA)
      );
      expect(fresh.ok).toBe(true);
    } finally {
      pendingA.resolve(completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } }));
      pendingB.resolve(completion());
    }
  });

  it('retains an unconfirmed root/incarnation failure and gates only fresh A work', async () => {
    const handlerDeps = deps({
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    const sessionA = { ...session, sessionId: 'ses_a', kiloSessionId: 'kilo_a' };
    const sessionB = { ...session, sessionId: 'ses_b', kiloSessionId: 'kilo_b' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    rememberAttachedRoot(sessionB.kiloSessionId, sessionB.directory);
    const runtime = handlerDeps.kiloRuntimes?.get(sessionA.directory);
    if (!runtime) throw new Error('Missing native runtime');
    const input = {
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'event rejected',
      deadlineAt: Date.now() + 1_000,
    };
    expect(await handlerDeps.operations.retireRootPublication(input)).toBe('unconfirmed');
    expect(await handlerDeps.operations.retireRootPublication(input)).toBe('unconfirmed');

    const authorizationA = operationAuthorization('session.prompt', 'message_a', sessionA);
    expect(
      await handleControlRequest(
        'session.prompt',
        sessionA,
        { ...promptPayload, messageId: 'message_a' },
        handlerDeps,
        authorizationA
      )
    ).toMatchObject({ ok: false, error: { code: 'not_ready', retryable: true } });
    expect(
      await handleControlRequest(
        'session.prompt',
        sessionA,
        { ...promptPayload, messageId: 'message_b' },
        handlerDeps
      )
    ).toMatchObject({ ok: false, error: { code: 'not_ready', retryable: true } });
    expect(
      await handleControlRequest('session.operation.get', sessionA, authorizationA, handlerDeps)
    ).toMatchObject({ ok: true, result: { state: 'missing' } });
    expect(
      await handleControlRequest('session.operation.ack', sessionA, {}, handlerDeps)
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });

    const authorizationB = operationAuthorization('session.prompt', 'message_b', sessionB);
    expect(
      await handleControlRequest(
        'session.prompt',
        sessionB,
        { ...promptPayload, messageId: 'message_b' },
        handlerDeps,
        authorizationB
      )
    ).toMatchObject({ ok: true, result: { status: 'accepted' } });
    const bRecord = handlerDeps.operations
      .retained()
      .find(record => record.messageId === 'message_b');
    if (!bRecord) throw new Error('Missing B operation record');
    await bRecord.done;
    await bRecord.waitForDelivery();
    expect(
      await handleControlRequest('session.operation.get', sessionB, authorizationB, handlerDeps)
    ).toMatchObject({ ok: true, result: { state: 'completed' } });
    const bDelivery = bRecord.deliveryResult();
    if (!bDelivery) throw new Error('Missing B delivery');
    expect(
      await handleControlRequest(
        'session.operation.ack',
        sessionB,
        await acknowledgeOperation(bDelivery),
        handlerDeps
      )
    ).toMatchObject({ ok: true, result: { acknowledged: true } });
  });

  it('uses unshared runtime retirement for operation-owned cleanup', async () => {
    const running = Promise.withResolvers<Completion>();
    const runtimeRetirement = mock(async () => 'unconfirmed' as const);
    const unsharedRetirement = mock(async () => 'shared' as const);
    const handlerDeps = deps({
      kiloClient: fakeKilo({ sendPrompt: async () => running.promise }),
    });
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Missing native runtimes');
    runtimes.retireRuntime = runtimeRetirement;
    runtimes.retireRuntimeIfUnshared = unsharedRetirement;
    const request = handleControlRequest('session.prompt', session, promptPayload, handlerDeps);
    let task: ReturnType<typeof handlerDeps.operations.active>;

    try {
      expect(await request).toMatchObject({
        ok: true,
        result: { messageId: promptPayload.messageId, status: 'accepted' },
      });
      task = handlerDeps.operations.active(session.kiloSessionId);
      if (!task) throw new Error('Missing active operation');
      for (let index = 0; index < 10 && !task.nativeTarget(); index += 1) await Promise.resolve();
      if (!task.nativeTarget()) throw new Error('Missing native operation target');
      task.requestRetirement('operation cleanup', Date.now() + 1_000);
      for (let index = 0; index < 10 && unsharedRetirement.mock.calls.length === 0; index += 1)
        await Promise.resolve();

      expect(unsharedRetirement).toHaveBeenCalledWith(
        session.directory,
        expect.objectContaining({ runtimeId: 'native_1' }),
        session.kiloSessionId,
        expect.any(Number),
        'operation cleanup'
      );
      expect(runtimeRetirement).not.toHaveBeenCalled();
    } finally {
      running.resolve(completion());
      await Promise.allSettled([request]);
      if (task) await task.done;
    }
  });

  it('retains terminal unconfirmed state across routing loss until explicit root notification', async () => {
    const handlerDeps = deps();
    const sessionA = { ...session, sessionId: 'ses_a', kiloSessionId: 'kilo_a' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    const runtime = handlerDeps.kiloRuntimes?.get(sessionA.directory);
    if (!runtime) throw new Error('Missing native runtime');
    const input = {
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'event rejected',
      deadlineAt: Date.now() + 1_000,
    };
    expect(await handlerDeps.operations.retireRootPublication(input)).toBe('unconfirmed');
    handlerDeps.operations.settleRootPublication({ ...input, result: 'unconfirmed' });

    expect(await handleControlRequest('session.detach', sessionA, {}, handlerDeps)).toMatchObject({
      ok: true,
      result: { detached: true },
    });
    handlerDeps.operations.prune();
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    expect(await handlerDeps.operations.retireRootPublication(input)).toBe('unconfirmed');
    expect(handlerDeps.operations.admission('session.prompt', sessionA, undefined).kind).toBe(
      'reply'
    );

    handlerDeps.operations.notifyRootDisappeared({
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
    });
    expect(handlerDeps.operations.admission('session.prompt', sessionA, undefined).kind).toBe(
      'continue'
    );
  });

  it('retains an unconfirmed record after physical unregistration and later no-op failures', async () => {
    const fixture = deps();
    const runtime = fixture.kiloRuntimes?.get(session.directory);
    if (!runtime) throw new Error('Missing native runtime');
    const nativeRetirement = mock(async () => 'unconfirmed' as const);
    const operations = createOperationRegistry({
      native: {
        get: () => runtime,
        getRetained: () => runtime,
        retireRuntime: nativeRetirement,
        verifyQuiescence: async () => false,
      },
      onStarted: () => {},
      onCompleted: () => {},
      retireRuntime: () => {},
    });
    const sessionA = { ...session, kiloSessionId: 'kilo_a', sessionId: 'ses_a' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    const input = {
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'event rejected',
      deadlineAt: Date.now() + 1_000,
    };
    expect(await operations.retireRootPublication(input)).toBe('unconfirmed');
    expect(
      await operations.retireDirectory(
        sessionA.directory,
        'physical',
        input.deadlineAt,
        input.target
      )
    ).toBe('unconfirmed');
    expect(nativeRetirement).toHaveBeenCalledTimes(1);

    expect(await handleControlRequest('session.detach', sessionA, {}, fixture)).toMatchObject({
      ok: true,
      result: { detached: true },
    });
    operations.prune();
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    expect(await operations.retireRootPublication(input)).toBe('unconfirmed');
    expect(operations.admission('session.prompt', sessionA, undefined).kind).toBe('reply');

    operations.notifyRootDisappeared({
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
    });
    expect(operations.admission('session.prompt', sessionA, undefined).kind).toBe('continue');
  });

  it('clears a scoped record after successful targeted retirement without a deferred intent', async () => {
    const fixture = deps();
    const runtime = fixture.kiloRuntimes?.get(session.directory);
    if (!runtime) throw new Error('Missing native runtime');
    const nativeRetirement = mock(async () => 'retired' as const);
    const operations = createOperationRegistry({
      native: {
        get: () => runtime,
        getRetained: () => runtime,
        retireRuntime: nativeRetirement,
        verifyQuiescence: async () => true,
      },
      onStarted: () => {},
      onCompleted: () => {},
      retireRuntime: () => {},
    });
    const sessionA = { ...session, kiloSessionId: 'kilo_a', sessionId: 'ses_a' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    const target = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };
    const input = {
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target,
      reason: 'targeted retirement',
      deadlineAt: Date.now() + 1_000,
    };
    expect(await operations.retireRootPublication(input)).toBe('unconfirmed');
    expect(
      await operations.retireDirectory(sessionA.directory, 'targeted', input.deadlineAt, target)
    ).toBe('retired');

    expect(operations.admission('session.prompt', sessionA, undefined).kind).toBe('continue');
  });

  it('invalidates a pending escalation before an unchanged same-root reattach can join the runtime', async () => {
    const handlerDeps = deps();
    const sessionA = { ...session, kiloSessionId: 'kilo_a', sessionId: 'ses_a' };
    const sessionB = { ...session, kiloSessionId: 'kilo_b', sessionId: 'ses_b' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    rememberAttachedRoot(sessionB.kiloSessionId, sessionB.directory);
    const runtime = handlerDeps.kiloRuntimes?.get(sessionA.directory);
    if (!runtime) throw new Error('Missing native runtime');
    let gateCalls = 0;
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Missing worktree runtimes');
    runtimes.retireRuntimeIfUnshared = async () => {
      gateCalls += 1;
      return 'shared';
    };
    const input = {
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'event rejected',
      deadlineAt: Date.now() + 1_000,
    };
    const escalation = handlerDeps.operations.escalateRootPublication(input);
    handlerDeps.operations.notifyRootDisappeared(input);
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    expect(await escalation.physical).toMatchObject({
      scope: 'runtime',
      physical: 'stale',
      runtimeRetired: false,
    });
    expect(gateCalls).toBe(0);
    expect(handlerDeps.operations.admission('session.prompt', sessionA, undefined).kind).toBe(
      'continue'
    );

    handlerDeps.operations.notifyRootDisappeared({
      directory: sessionB.directory,
      root: sessionB.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
    });
    expect(gateCalls).toBe(0);
  });

  it.each(['unconfirmed', 'retired'] as const)(
    'replaces a cached shared disposition when the runtime owner starts a physical attempt (%s)',
    async result => {
      const fixture = deps();
      const runtime = fixture.kiloRuntimes?.get(session.directory);
      if (!runtime) throw new Error('Missing native runtime');
      const operations = createOperationRegistry({
        native: {
          get: () => runtime,
          getRetained: () => runtime,
          rootRetirementScope: () => 'shared',
          retireRuntime: async () => 'unconfirmed',
          retireRuntimeIfUnshared: async () => 'shared',
          verifyQuiescence: async () => false,
        },
        onStarted: () => {},
        onCompleted: () => {},
        retireRuntime: () => {},
      });
      const target = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };
      const input = {
        directory: session.directory,
        root: session.kiloSessionId,
        nativeRuntimeId: runtime.runtimeId,
        target,
        reason: 'deferred physical cleanup',
        deadlineAt: Date.now() + 1_000,
      };
      const initial = operations.escalateRootPublication(input);
      const initialDisposition = await initial.physical;
      expect(initialDisposition).toMatchObject({
        scope: 'root',
        physical: 'shared',
        runtimeRetired: false,
      });

      const retirementId = crypto.randomUUID();
      operations.markRootRetirementStarted({ ...input, retirementId });
      const retainedStop = operations.escalateRootPublication(input);
      const originalDisposition = initial.disposition();
      const retainedDisposition = retainedStop.disposition();
      expect(originalDisposition).toMatchObject({
        scope: 'runtime',
        physical: 'pending',
        physicalAttemptStarted: true,
        runtimeRetired: false,
      });
      expect(retainedDisposition).toEqual(originalDisposition);
      operations.settleRootPublication({ ...input, retirementId, result });
      const settledDisposition = await retainedStop.physical;
      expect(settledDisposition).toMatchObject({
        scope: 'runtime',
        physical: result,
        runtimeRetired: result === 'retired',
      });
    }
  );

  it('starts a current runtime retirement after a cached root result loses membership', async () => {
    const fixture = deps();
    const runtime = fixture.kiloRuntimes?.get(session.directory);
    if (!runtime) throw new Error('Missing native runtime');
    let scope: 'shared' | 'sole' = 'shared';
    let attempts = 0;
    const retirement = Promise.withResolvers<'retired'>();
    const operations = createOperationRegistry({
      native: {
        get: () => runtime,
        getRetained: () => runtime,
        rootRetirementScope: () => scope,
        retireRuntime: async () => 'unconfirmed',
        retireRuntimeIfUnshared: async () => {
          attempts += 1;
          if (attempts === 1) return 'shared';
          return retirement.promise;
        },
        verifyQuiescence: async () => false,
      },
      onStarted: () => {},
      onCompleted: () => {},
      retireRuntime: () => {},
    });
    const target = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };
    const input = {
      directory: session.directory,
      root: session.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target,
      reason: 'deferred physical cleanup',
      deadlineAt: Date.now() + 1_000,
    };
    try {
      const initial = operations.escalateRootPublication(input);
      expect(await initial.physical).toMatchObject({
        scope: 'root',
        physical: 'shared',
        runtimeRetired: false,
      });

      scope = 'sole';
      const retainedStop = operations.escalateRootPublication(input);
      for (let index = 0; index < 10 && attempts < 2; index += 1) await Promise.resolve();
      expect(attempts).toBe(2);
      expect(retainedStop.disposition()).toMatchObject({
        scope: 'runtime',
        physical: 'pending',
        runtimeRetired: false,
      });
      let settled = false;
      const physical = retainedStop.physical.then(result => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      retirement.resolve('retired');
      expect(await physical).toMatchObject({
        scope: 'runtime',
        physical: 'retired',
        runtimeRetired: true,
      });
    } finally {
      retirement.resolve('retired');
    }
  });

  it('does not let a superseded retained A1 Stop retire active A2 after confirmed root cleanup', async () => {
    const runningA1 = Promise.withResolvers<Completion>();
    const runningA2 = Promise.withResolvers<Completion>();
    const startedA1 = Promise.withResolvers<void>();
    const startedA2 = Promise.withResolvers<void>();
    const sessionA = { ...session, sessionId: 'ses_a', kiloSessionId: 'kilo_a' };
    const sessionB = { ...session, sessionId: 'ses_b', kiloSessionId: 'kilo_b' };
    const client = fakeKilo({
      sendPrompt: async options => {
        if (options.messageId === 'message_a1') {
          startedA1.resolve();
          return runningA1.promise;
        }
        if (options.messageId === 'message_a2') {
          startedA2.resolve();
          return runningA2.promise;
        }
        return completion();
      },
      getSessionStatuses: async () => ({
        [sessionA.kiloSessionId]: { type: 'idle' },
        [sessionB.kiloSessionId]: { type: 'idle' },
      }),
      abortSession: async () => true,
    });
    const handlerDeps = deps({
      kiloClient: client,
      scopedCleanupResult: true,
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    rememberAttachedRoot(sessionB.kiloSessionId, sessionB.directory);
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Missing worktree runtimes');
    const runtime = runtimes.get(sessionA.directory);
    if (!runtime) throw new Error('Missing native runtime');
    const attachedRoots = new Set([sessionA.kiloSessionId, sessionB.kiloSessionId]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- capture before wrap
    const originalDetach = runtimes.detach;
    runtimes.detach = identity => {
      attachedRoots.delete(identity.kiloSessionId);
      return originalDetach.call(runtimes, identity);
    };
    runtimes.rootRetirementScope = (_directory, _target, retiringRoot) =>
      attachedRoots.has(retiringRoot) ? (attachedRoots.size > 1 ? 'shared' : 'sole') : 'stale';
    if (!runtimes.retireRuntime) throw new Error('Missing runtime retirement');
    let retireRuntimeIfUnsharedCalls = 0;
    runtimes.retireRuntimeIfUnshared = async (directory, target, retiringRoot, deadlineAt) => {
      retireRuntimeIfUnsharedCalls += 1;
      if (runtimes.rootRetirementScope?.(directory, target, retiringRoot) === 'shared')
        return 'shared';
      const retirement = await runtimes.retireRuntime?.(directory, deadlineAt, target);
      if (retirement === undefined) throw new Error('Missing runtime retirement');
      return retirement;
    };
    const integratedDeps = createControlHandlerDeps(handlerDeps);
    const originalDeadlineAt = Date.now() + 5_000;
    const input = {
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'confirmed publication cleanup',
      deadlineAt: originalDeadlineAt,
    };
    const authorizationA1 = operationAuthorization('session.prompt', 'message_a1', sessionA);
    const authorizationA2 = operationAuthorization('session.prompt', 'message_a2', sessionA);
    const requestA1 = handleControlRequest(
      'session.prompt',
      sessionA,
      { ...promptPayload, messageId: 'message_a1' },
      integratedDeps,
      authorizationA1
    );
    let requestA2: ReturnType<typeof handleControlRequest> | undefined;
    try {
      await startedA1.promise;
      expect(await requestA1).toMatchObject({ ok: true, result: { status: 'accepted' } });
      const publication = integratedDeps.operations.escalateRootPublication(input);
      expect(await publication.physical).toMatchObject({
        scope: 'root',
        cleanup: 'confirmed',
        physical: 'not_attempted',
        runtimeRetired: false,
      });

      runningA1.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      const retainedA1 = integratedDeps.operations
        .retained()
        .find(operation => operation.messageId === 'message_a1');
      if (!retainedA1) throw new Error('Missing retained A1 operation');
      await retainedA1.done;
      await retainedA1.waitForDelivery();

      requestA2 = handleControlRequest(
        'session.prompt',
        sessionA,
        { ...promptPayload, messageId: 'message_a2' },
        integratedDeps,
        authorizationA2
      );
      expect(await requestA2).toMatchObject({ ok: true, result: { status: 'accepted' } });
      await startedA2.promise;
      const a2 = integratedDeps.operations.active(sessionA.kiloSessionId);
      if (!a2) throw new Error('Missing active A2 operation');
      expect(integratedDeps.operations.retained()).toContain(retainedA1);
      const supersededWithoutClaim = integratedDeps.operations.escalateRootPublication(input);
      expect(supersededWithoutClaim.cleanup).not.toBe(publication.cleanup);
      expect(a2.publicationScope()?.claim).toBeDefined();
      expect(a2.signal.aborted).toBe(true);
      expect(integratedDeps.operations.admission('session.prompt', sessionA, undefined).kind).toBe(
        'reply'
      );
      expect(await supersededWithoutClaim.physical).toMatchObject({
        scope: 'root',
        status: 'aborted',
        cleanup: 'confirmed',
        physical: 'not_attempted',
        quiescent: false,
        runtimeRetired: false,
      });
      const unknownClaim = integratedDeps.operations.escalateRootPublication({
        ...input,
        expectedClaim: Symbol('unknown-claim'),
      });
      expect(await unknownClaim.physical).toMatchObject({
        scope: 'runtime',
        status: 'unconfirmed',
        physical: 'stale',
        quiescent: false,
        runtimeRetired: false,
      });

      expect(
        await handleControlRequest('session.detach', sessionB, {}, integratedDeps)
      ).toMatchObject({
        ok: true,
        result: { detached: true },
      });
      const stopped = await handleControlRequest(
        'session.abort',
        sessionA,
        {
          messageId: 'message_a1',
          operationId: '11111111-1111-4111-8111-111111111111',
          cleanupDeadlineAt: originalDeadlineAt,
        },
        integratedDeps
      );
      expect(stopped).toMatchObject({
        ok: true,
        result: { status: 'already_idle', quiescent: false },
      });
      expect(stopped).not.toHaveProperty('result.cleanupScope');
      expect(stopped).not.toHaveProperty('result.runtimeRetired');
      expect(retireRuntimeIfUnsharedCalls).toBe(0);
      expect(integratedDeps.kiloRuntimes?.get(sessionA.directory)).toBe(runtime);
      expect(runtime.signal.aborted).toBe(false);
      expect(a2.signal.aborted).toBe(true);

      runningA2.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      await requestA2;
    } finally {
      runningA1.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      runningA2.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      await Promise.allSettled([requestA1, ...(requestA2 ? [requestA2] : [])]);
      for (const operation of integratedDeps.operations.activeOperations()) await operation.done;
    }
  });

  it('returns already_idle for a retained A1 Stop without aborting healthy active A2', async () => {
    const runningA1 = Promise.withResolvers<Completion>();
    const runningA2 = Promise.withResolvers<Completion>();
    const startedA1 = Promise.withResolvers<void>();
    const startedA2 = Promise.withResolvers<void>();
    const sessionA = { ...session, sessionId: 'ses_a', kiloSessionId: 'kilo_a' };
    const sessionB = { ...session, sessionId: 'ses_b', kiloSessionId: 'kilo_b' };
    const client = fakeKilo({
      sendPrompt: async options => {
        if (options.messageId === 'message_a1') {
          startedA1.resolve();
          return runningA1.promise;
        }
        if (options.messageId === 'message_a2') {
          startedA2.resolve();
          return runningA2.promise;
        }
        return completion();
      },
      getSessionStatuses: async () => ({
        [sessionA.kiloSessionId]: { type: 'idle' },
        [sessionB.kiloSessionId]: { type: 'idle' },
      }),
      abortSession: async () => true,
    });
    const handlerDeps = deps({
      kiloClient: client,
      scopedCleanupResult: true,
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    rememberAttachedRoot(sessionB.kiloSessionId, sessionB.directory);
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Missing worktree runtimes');
    const runtime = runtimes.get(sessionA.directory);
    if (!runtime) throw new Error('Missing native runtime');
    const attachedRoots = new Set([sessionA.kiloSessionId, sessionB.kiloSessionId]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- capture before wrap
    const originalDetach = runtimes.detach;
    runtimes.detach = identity => {
      attachedRoots.delete(identity.kiloSessionId);
      return originalDetach.call(runtimes, identity);
    };
    runtimes.rootRetirementScope = (_directory, _target, retiringRoot) =>
      attachedRoots.has(retiringRoot) ? (attachedRoots.size > 1 ? 'shared' : 'sole') : 'stale';
    if (!runtimes.retireRuntime) throw new Error('Missing runtime retirement');
    let retireRuntimeIfUnsharedCalls = 0;
    runtimes.retireRuntimeIfUnshared = async (directory, target, retiringRoot, deadlineAt) => {
      retireRuntimeIfUnsharedCalls += 1;
      if (runtimes.rootRetirementScope?.(directory, target, retiringRoot) === 'shared')
        return 'shared';
      const retirement = await runtimes.retireRuntime?.(directory, deadlineAt, target);
      if (retirement === undefined) throw new Error('Missing runtime retirement');
      return retirement;
    };
    const integratedDeps = createControlHandlerDeps(handlerDeps);
    const input = {
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'confirmed publication cleanup',
      deadlineAt: Date.now() + 5_000,
    };
    const authorizationA1 = operationAuthorization('session.prompt', 'message_a1', sessionA);
    const authorizationA2 = operationAuthorization('session.prompt', 'message_a2', sessionA);
    const requestA1 = handleControlRequest(
      'session.prompt',
      sessionA,
      { ...promptPayload, messageId: 'message_a1' },
      integratedDeps,
      authorizationA1
    );
    let requestA2: ReturnType<typeof handleControlRequest> | undefined;
    try {
      await startedA1.promise;
      expect(await requestA1).toMatchObject({ ok: true, result: { status: 'accepted' } });
      const publication = integratedDeps.operations.escalateRootPublication(input);
      expect(await publication.physical).toMatchObject({
        scope: 'root',
        cleanup: 'confirmed',
        physical: 'not_attempted',
        runtimeRetired: false,
      });

      runningA1.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      const retainedA1 = integratedDeps.operations
        .retained()
        .find(operation => operation.messageId === 'message_a1');
      if (!retainedA1) throw new Error('Missing retained A1 operation');
      await retainedA1.done;
      await retainedA1.waitForDelivery();

      requestA2 = handleControlRequest(
        'session.prompt',
        sessionA,
        { ...promptPayload, messageId: 'message_a2' },
        integratedDeps,
        authorizationA2
      );
      expect(await requestA2).toMatchObject({ ok: true, result: { status: 'accepted' } });
      await startedA2.promise;
      const a2 = integratedDeps.operations.active(sessionA.kiloSessionId);
      if (!a2) throw new Error('Missing active A2 operation');
      expect(a2.publicationScope()).toBeUndefined();
      expect(integratedDeps.operations.retained()).toContain(retainedA1);

      expect(
        await handleControlRequest('session.detach', sessionB, {}, integratedDeps)
      ).toMatchObject({
        ok: true,
        result: { detached: true },
      });
      const stopped = await handleControlRequest(
        'session.abort',
        sessionA,
        {
          messageId: 'message_a1',
          operationId: '11111111-1111-4111-8111-111111111111',
          cleanupDeadlineAt: input.deadlineAt,
        },
        integratedDeps
      );
      expect(stopped).toMatchObject({
        ok: true,
        result: { status: 'already_idle', quiescent: false },
      });
      expect(stopped).not.toHaveProperty('result.cleanupScope');
      expect(stopped).not.toHaveProperty('result.runtimeRetired');
      expect(retireRuntimeIfUnsharedCalls).toBe(0);
      expect(integratedDeps.kiloRuntimes?.get(sessionA.directory)).toBe(runtime);
      expect(runtime.signal.aborted).toBe(false);
      expect(a2.signal.aborted).toBe(false);

      runningA2.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      await requestA2;
    } finally {
      runningA1.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      runningA2.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      await Promise.allSettled([requestA1, ...(requestA2 ? [requestA2] : [])]);
      for (const operation of integratedDeps.operations.activeOperations()) await operation.done;
    }
  });

  it('bounds archived publication claims by their operation owners', async () => {
    const createRun = () => ({
      started: Promise.withResolvers<void>(),
      finalizerStarted: Promise.withResolvers<void>(),
      finalized: Promise.withResolvers<{ success: boolean }>(),
    });
    type Run = ReturnType<typeof createRun>;
    const runs = new Map<string, Run>();
    const pendingFinalizers: Run[] = [];
    const client = fakeKilo({
      sendPrompt: async options => {
        const run = runs.get(options.messageId);
        if (!run) throw new Error(`Missing run for ${options.messageId}`);
        run.started.resolve();
        pendingFinalizers.push(run);
        return completion();
      },
      getSessionStatuses: async () => ({
        kilo_a: { type: 'idle' },
        kilo_b: { type: 'idle' },
      }),
      abortSession: async () => true,
    });
    const handlerDeps = deps({
      kiloClient: client,
      scopedCleanupResult: true,
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
      runAutoCommit: async () => {
        const run = pendingFinalizers.shift();
        if (!run) throw new Error('Missing finalizer run');
        run.finalizerStarted.resolve();
        return run.finalized.promise;
      },
    });
    const sessionA = { ...session, sessionId: 'ses_a', kiloSessionId: 'kilo_a' };
    const sessionB = { ...session, sessionId: 'ses_b', kiloSessionId: 'kilo_b' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    rememberAttachedRoot(sessionB.kiloSessionId, sessionB.directory);
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Missing worktree runtimes');
    const runtime = runtimes.get(sessionA.directory);
    if (!runtime) throw new Error('Missing native runtime');
    runtimes.rootRetirementScope = () => 'shared';
    const integratedDeps = createControlHandlerDeps(handlerDeps);
    const base = Date.now();
    const dispatchDeadlineAt = (index: number) =>
      index === 1 ? base + 10_000_000 : base + index * 100_000;
    const input = {
      directory: sessionA.directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'repeated publication cleanup',
      deadlineAt: base + 5_000,
    };
    const start = async (index: number) => {
      const messageId = `message_a${index}`;
      const run = createRun();
      runs.set(messageId, run);
      const authorization = {
        ...operationAuthorization('session.prompt', messageId, sessionA),
        dispatchDeadlineAt: dispatchDeadlineAt(index),
      };
      const request = handleControlRequest(
        'session.prompt',
        sessionA,
        { ...promptPayload, messageId, finalization: { autoCommit: true } },
        integratedDeps,
        authorization
      );
      await run.started.promise;
      await run.finalizerStarted.promise;
      expect(await request).toMatchObject({ ok: true, result: { status: 'accepted' } });
      const operation = integratedDeps.operations.active(sessionA.kiloSessionId);
      if (!operation) throw new Error(`Missing active operation for ${messageId}`);
      return { operation, run };
    };
    const finish = async (
      run: Run,
      operation: ReturnType<typeof integratedDeps.operations.active>
    ) => {
      if (!operation) throw new Error('Missing operation to finish');
      run.finalized.resolve({ success: true });
      await operation.done;
      await operation.waitForDelivery();
    };
    try {
      const first = await start(1);
      const firstPublication = integratedDeps.operations.escalateRootPublication(input);
      expect(await firstPublication.physical).toMatchObject({
        scope: 'root',
        cleanup: 'confirmed',
        physical: 'not_attempted',
        runtimeRetired: false,
      });
      const firstClaim = first.operation.publicationScope()?.claim;
      if (firstClaim === undefined) throw new Error('Missing first publication claim');
      await finish(first.run, first.operation);

      const second = await start(2);
      const secondPublication = integratedDeps.operations.escalateRootPublication(input);
      expect(second.operation.publicationScope()?.claim).toBeDefined();
      expect(integratedDeps.operations.admission('session.prompt', sessionA, undefined).kind).toBe(
        'reply'
      );
      expect(integratedDeps.operations.admission('session.prompt', sessionB, undefined).kind).toBe(
        'continue'
      );
      expect(await secondPublication.physical).toMatchObject({
        scope: 'root',
        cleanup: 'confirmed',
        physical: 'not_attempted',
        runtimeRetired: false,
      });
      await finish(second.run, second.operation);
      expect(integratedDeps.operations.counts().archived).toBe(1);
      expect(
        await integratedDeps.operations.escalateRootPublication({
          ...input,
          expectedClaim: firstClaim,
        }).physical
      ).toMatchObject({ status: 'already_idle', physical: 'not_attempted' });

      let previous = second;
      for (let index = 3; index <= 7; index += 1) {
        const next = await start(index);
        const previousClaim = previous.operation.publicationScope()?.claim;
        if (previousClaim === undefined) throw new Error('Missing previous publication claim');
        const publication = integratedDeps.operations.escalateRootPublication(input);
        expect(await publication.physical).toMatchObject({
          scope: 'root',
          cleanup: 'confirmed',
          physical: 'not_attempted',
          runtimeRetired: false,
        });
        expect(integratedDeps.operations.counts().archived).toBe(2);
        await finish(next.run, next.operation);
        integratedDeps.operations.prune(base + (index - 1) * 100_000 + 1);
        expect(integratedDeps.operations.counts().archived).toBe(1);
        previous = next;
      }

      integratedDeps.operations.prune(base + 10_000_001);
      expect(integratedDeps.operations.counts()).toEqual({ active: 0, retained: 0, archived: 0 });
    } finally {
      for (const run of runs.values()) run.finalized.resolve({ success: true });
      await Promise.allSettled(
        integratedDeps.operations.activeOperations().map(operation => operation.done)
      );
    }
  });

  it('does not let a retained A1 Stop reselect fresh active A2 after root invalidation', async () => {
    const runningA1 = Promise.withResolvers<Completion>();
    const runningA2 = Promise.withResolvers<Completion>();
    const runningB = Promise.withResolvers<Completion>();
    const startedA1 = Promise.withResolvers<void>();
    const startedA2 = Promise.withResolvers<void>();
    const startedB = Promise.withResolvers<void>();
    let status: 'busy' | 'idle' = 'busy';
    let gateCalls = 0;
    const client = fakeKilo({
      sendPrompt: async options => {
        if (options.messageId === 'message_a1') {
          startedA1.resolve();
          return runningA1.promise;
        }
        if (options.messageId === 'message_a2') {
          startedA2.resolve();
          return runningA2.promise;
        }
        startedB.resolve();
        return runningB.promise;
      },
      getSessionStatuses: async () => ({ kilo_a: { type: status } }),
      abortSession: async () => true,
    });
    const handlerDeps = deps({
      kiloClient: client,
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    const sessionA = { ...session, sessionId: 'ses_a', kiloSessionId: 'kilo_a' };
    const sessionB = { ...session, sessionId: 'ses_b', kiloSessionId: 'kilo_b' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    rememberAttachedRoot(sessionB.kiloSessionId, sessionB.directory);
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Missing worktree runtimes');
    runtimes.retireRuntimeIfUnshared = async () => {
      gateCalls += 1;
      return 'shared';
    };
    const authorizationA1 = operationAuthorization('session.prompt', 'message_a1', sessionA);
    const requestA1 = handleControlRequest(
      'session.prompt',
      sessionA,
      { ...promptPayload, messageId: 'message_a1' },
      handlerDeps,
      authorizationA1
    );
    try {
      await startedA1.promise;
      const target = handlerDeps.kiloRuntimes?.get(sessionA.directory);
      if (!target) throw new Error('Missing native runtime');
      expect(
        await handlerDeps.operations.retireRootPublication({
          directory: sessionA.directory,
          root: sessionA.kiloSessionId,
          nativeRuntimeId: target.runtimeId,
          target: { runtimeId: target.runtimeId, client: target.kiloClient },
          reason: 'event rejected',
          deadlineAt: Date.now() + 20,
        })
      ).toBe('unconfirmed');
      runningA1.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      await requestA1;
      const retainedA1 = handlerDeps.operations
        .retained()
        .find(record => record.messageId === 'message_a1');
      if (!retainedA1) throw new Error('Missing retained A1 operation');
      await retainedA1.done;
      await retainedA1.waitForDelivery();

      expect(await handleControlRequest('session.detach', sessionA, {}, handlerDeps)).toMatchObject(
        {
          ok: true,
          result: { detached: true },
        }
      );
      handlerDeps.operations.notifyRootDisappeared({
        directory: sessionA.directory,
        root: sessionA.kiloSessionId,
        nativeRuntimeId: target.runtimeId,
        target: { runtimeId: target.runtimeId, client: target.kiloClient },
      });
      const attachAuthorization = operationAuthorization('session.attach', undefined, sessionA);
      expect(
        await handleControlRequest(
          'session.attach',
          sessionA,
          { kilo },
          handlerDeps,
          attachAuthorization
        )
      ).toMatchObject({ ok: true });

      const requestB = handleControlRequest(
        'session.prompt',
        sessionB,
        { ...promptPayload, messageId: 'message_b' },
        handlerDeps
      );
      const requestA2 = handleControlRequest(
        'session.prompt',
        sessionA,
        { ...promptPayload, messageId: 'message_a2' },
        handlerDeps
      );
      await startedB.promise;
      await startedA2.promise;
      const a2 = handlerDeps.operations.active(sessionA.kiloSessionId);
      const b = handlerDeps.operations.active(sessionB.kiloSessionId);
      if (!a2 || !b) throw new Error('Missing fresh active operations');
      const stopped = await handleControlRequest(
        'session.abort',
        sessionA,
        { messageId: 'message_a1', operationId: '11111111-1111-4111-8111-111111111111' },
        handlerDeps
      );
      expect(stopped).toMatchObject({ ok: true, result: { quiescent: false } });
      expect(a2.signal.aborted).toBe(false);
      expect(b.signal.aborted).toBe(false);
      expect(gateCalls).toBe(0);

      status = 'idle';
      runningB.resolve(completion({ name: 'MessageAbortedError', data: { message: 'detached' } }));
      await requestB;
      expect(await handleControlRequest('session.detach', sessionB, {}, handlerDeps)).toMatchObject(
        {
          ok: true,
          result: { detached: true },
        }
      );
      expect(a2.signal.aborted).toBe(false);
      expect(gateCalls).toBe(0);
      runningA2.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      await requestA2;
    } finally {
      status = 'idle';
      runningA1.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      runningA2.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      runningB.resolve(completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } }));
      await Promise.allSettled([requestA1]);
      for (const task of handlerDeps.operations.activeOperations()) await task.done;
    }
  });

  it('coalesces authorized and unauthorized active operations under one root claim', async () => {
    const pendingAuthorized = Promise.withResolvers<Completion>();
    const pendingUnauthorized = Promise.withResolvers<Completion>();
    const client = fakeKilo({
      sendPrompt: async options =>
        options.messageId === 'message_authorized'
          ? pendingAuthorized.promise
          : pendingUnauthorized.promise,
      abortSession: async () => true,
      getSessionStatuses: async () => ({ kilo_a: { type: 'idle' } }),
    });
    const handlerDeps = deps({ kiloClient: client });
    const sessionA = { ...session, sessionId: 'ses_a', kiloSessionId: 'kilo_a' };
    const child = { ...session, sessionId: 'ses_child', kiloSessionId: 'child_a' };
    rememberAttachedRoot(sessionA.kiloSessionId, sessionA.directory);
    rememberChildSession({ childId: child.kiloSessionId, parentId: sessionA.kiloSessionId });
    const runtime = handlerDeps.kiloRuntimes?.get(sessionA.directory);
    if (!runtime) throw new Error('Missing native runtime');
    const authorized = handlerDeps.operations.start(
      sessionA,
      operationAuthorization('session.prompt', 'message_authorized', sessionA),
      {
        operation: 'session.prompt',
        payload: { ...promptPayload, messageId: 'message_authorized' },
        runtime,
      },
      { emitSessionEvent: () => true }
    );
    const unauthorized = handlerDeps.operations.start(
      child,
      undefined,
      {
        operation: 'session.prompt',
        payload: { ...promptPayload, messageId: 'message_unauthorized' },
        runtime,
      },
      { emitSessionEvent: () => true }
    );
    try {
      for (let index = 0; index < 10; index += 1) {
        if (
          authorized.snapshot().native.state === 'pending' &&
          unauthorized.snapshot().native.state === 'pending'
        )
          break;
        await Promise.resolve();
      }
      const input = {
        directory: sessionA.directory,
        root: sessionA.kiloSessionId,
        nativeRuntimeId: runtime.runtimeId,
        target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
        reason: 'coalesced publication failure',
        deadlineAt: Date.now() + 1_000,
      };
      const first = handlerDeps.operations.retireRootPublication(input);
      const duplicate = handlerDeps.operations.retireRootPublication(input);
      expect(duplicate).toBe(first);
      expect(await first).toBe('confirmed');
      expect(authorized.publicationScope()?.claim).toBe(unauthorized.publicationScope()?.claim);
    } finally {
      pendingAuthorized.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      pendingUnauthorized.resolve(
        completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } })
      );
      await Promise.all([authorized.done, unauthorized.done]);
    }
  });

  it('looks up the same operation during and after completion and rejects changed intent', async () => {
    const running = Promise.withResolvers<Completion>();
    const started = Promise.withResolvers<void>();
    let submissions = 0;
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        sendPrompt: async () => {
          submissions++;
          started.resolve();
          return running.promise;
        },
      }),
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    const authorization = operationAuthorization();
    await handleControlRequest(
      'session.prompt',
      session,
      promptPayload,
      handlerDeps,
      authorization
    );
    await started.promise;
    const record = onlyOperation(handlerDeps);
    expect(handlerDeps.operations.active(session.kiloSessionId)).toBe(record);
    const lookup = await handleControlRequest(
      'session.operation.get',
      session,
      authorization,
      handlerDeps
    );
    expect(lookup).toMatchObject({ ok: true, result: { state: 'running', authorization } });
    if (!lookup.ok) throw new Error('Missing running operation receipt');
    expect(sessionOperationLookupResultSchema.parse(lookup.result)).toEqual({
      state: 'running',
      authorization,
      executionDeadlineAt: record.executionDeadlineAt,
    });
    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        promptPayload,
        handlerDeps,
        authorization
      )
    ).toMatchObject({ ok: true, result: { status: 'existing' } });
    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        { ...promptPayload, agent: { ...promptPayload.agent, variant: 'low' } },
        handlerDeps,
        authorization
      )
    ).toMatchObject({ ok: false, error: { code: 'idempotency_conflict' } });
    const prepareHistory = spyOn(handlerDeps.kiloRuntimes!, 'isHealthy').mockReturnValue(true);
    try {
      expect(
        await handleControlRequest('session.operation.get', session, authorization, handlerDeps)
      ).toMatchObject({ ok: true, result: { state: 'running', authorization } });
      expect(submissions).toBe(1);
    } finally {
      prepareHistory.mockRestore();
      running.resolve(completion());
    }
    await record.done;
    await record.waitForDelivery();
    expect(record.snapshot().native.completion).toEqual(completion().info);
    expect(record.snapshot().local?.result.ok).toBe(true);
    expect(record.snapshot().delivery?.state).toBe('acknowledged');
    expect(
      await handleControlRequest(
        'session.abort',
        session,
        {
          messageId: authorization.messageId,
          operationId: '11111111-1111-4111-8111-111111111111',
          cleanupDeadlineAt: Date.now() + 1_000,
        },
        handlerDeps
      )
    ).toMatchObject({
      ok: true,
      result: {
        status: 'aborted',
        quiescent: true,
        delivery: { authorization },
      },
    });
    expect(handlerDeps.operations.counts().active).toBe(0);
    expect(
      await handleControlRequest('session.operation.get', session, authorization, handlerDeps)
    ).toMatchObject({
      ok: true,
      result: { state: 'completed', delivery: { outcome: { status: 'completed' } } },
    });
    await handleControlRequest(
      'session.prompt',
      session,
      promptPayload,
      handlerDeps,
      authorization
    );
    expect(submissions).toBe(1);
  });

  it('preserves lookup at capacity and rejects expired replay after safe pruning', async () => {
    const handlerDeps = deps({
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    const first = operationAuthorization();
    for (let index = 0; index < SANDBOX_CONTROL_OPERATION_LIMIT; index++) {
      const messageId = `message_${index}`;
      const authorization = { ...first, messageId, operationId: messageId };
      await handleControlRequest(
        'session.prompt',
        session,
        { ...promptPayload, messageId },
        handlerDeps,
        authorization
      );
      const record = [...handlerDeps.operations.retained()].at(-1);
      if (!record) throw new Error('Missing admitted record');
      await record.done;
      await record.waitForDelivery();
    }
    const original = { ...first, messageId: 'message_0', operationId: 'message_0' };
    expect(
      await handleControlRequest('session.operation.get', session, original, handlerDeps)
    ).toMatchObject({ ok: true, result: { state: 'completed' } });
    expect(
      await handleControlRequest('session.prompt', session, promptPayload, handlerDeps, first)
    ).toMatchObject({
      ok: false,
      error: { code: 'session_busy', admission: 'not-admitted' },
    });
    setSystemTime(first.dispatchDeadlineAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS + 1);
    pruneControlOperations(handlerDeps);
    expect(handlerDeps.operations.counts().retained).toBe(0);
    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        { ...promptPayload, messageId: original.messageId },
        handlerDeps,
        original
      )
    ).toMatchObject({ ok: false, error: { code: 'not_ready', retryable: false } });
    expect(handlerDeps.operations.counts().active).toBe(0);
  });

  it('aborts a retained prompt instead of a same-message attach', async () => {
    const handlerDeps = deps({
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    const attachAuth = operationAuthorization('session.attach');
    await handleControlRequest('session.attach', session, { kilo }, handlerDeps, attachAuth);
    const attached = handlerDeps.operations.retained()[0];
    if (!attached) throw new Error('Missing attach');
    await attached.done;
    await attached.waitForDelivery();
    const promptAuth = operationAuthorization();
    await handleControlRequest('session.prompt', session, promptPayload, handlerDeps, promptAuth);
    const prompt = handlerDeps.operations
      .retained()
      .find(operation => operation.kind !== 'preparation');
    if (!prompt) throw new Error('Missing prompt');
    await prompt.done;
    await prompt.waitForDelivery();
    expect(handlerDeps.operations.abortTarget(session, 'msg_1')).toBe(prompt);
  });

  it('includes working branch mode in attach idempotency intent', () => {
    const workingBranchPayload = {
      kilo,
      branch: 'kilo/quiet-forest-abc',
      branchMode: 'working' as const,
    };
    const { branchMode: _branchMode, ...legacyPayload } = workingBranchPayload;

    expect(operationIntent('session.attach', workingBranchPayload)).toMatchObject({
      branch: 'kilo/quiet-forest-abc',
      branchMode: 'working',
    });
    expect(operationIntent('session.attach', workingBranchPayload)).not.toEqual(
      operationIntent('session.attach', legacyPayload)
    );
  });
});

describe('completed receipt prune', () => {
  it('does not retire the wrapper when a completed receipt still has leftover occupancy', async () => {
    const retired: string[] = [];
    const diagnostics: Array<{ event: string; fields: ControlDiagnosticFields }> = [];
    const handlerDeps = deps({
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
      retireRuntime: reason => {
        retired.push(reason);
      },
      onDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
    });
    const nativeRuntime = handlerDeps.kiloRuntimes;
    if (!nativeRuntime) throw new Error('Missing native runtime');
    const nativeRetire = spyOn(nativeRuntime, 'retireRuntime').mockResolvedValue('unconfirmed');
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    const authorization = operationAuthorization();
    await handleControlRequest(
      'session.prompt',
      session,
      promptPayload,
      handlerDeps,
      authorization
    );
    const record = onlyOperation(handlerDeps);
    await record.done;
    await record.waitForDelivery();

    const release = spyOn(record, 'releaseProcessOwnership').mockReturnValue(false);
    const cleaned = Promise.withResolvers<void>();
    const cleanup = spyOn(record, 'cleanupOwnedWork').mockImplementation(async () => {
      cleaned.resolve();
      return false;
    });
    const requestRetirement = spyOn(record, 'requestRetirement');
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const runtime = nativeRuntime.get(session.directory);
    if (!runtime) throw new Error('Missing native runtime');
    const attachStarted = Promise.withResolvers<void>();
    const attachRelease = Promise.withResolvers<void>();
    let attachAborted = false;
    const attaching = handleControlRequest(
      'session.attach',
      session,
      { kilo },
      {
        ...handlerDeps,
        applyAttach: async (_identity, _payload, hooks) => {
          if (!hooks.onRuntime) throw new Error('Missing attach runtime hook');
          hooks.onRuntime(runtime);
          const signal = hooks.signal;
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                attachAborted = true;
              },
              { once: true }
            );
          }
          attachStarted.resolve();
          await attachRelease.promise;
          if (signal?.aborted) {
            return {
              ok: false,
              error: {
                code: 'not_ready',
                message: 'Session attachment cancelled',
                retryable: true,
              },
            };
          }
          return { ok: true, result: { attached: true } };
        },
      }
    );
    try {
      await attachStarted.promise;
      setSystemTime(authorization.dispatchDeadlineAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS + 1);
      pruneControlOperations(handlerDeps);
      await cleaned.promise;
      await Promise.resolve();
      await Promise.resolve();

      expect(requestRetirement).not.toHaveBeenCalled();
      expect(retired).toEqual([]);
      expect(attachAborted).toBe(false);
      expect(handlerDeps.operations.retained()).not.toContain(record);
      expect(
        diagnostics.some(
          diagnostic =>
            diagnostic.event === 'session.task' &&
            diagnostic.fields.stage === 'process_cleanup' &&
            diagnostic.fields.phase === 'failed' &&
            diagnostic.fields.ok === false &&
            diagnostic.fields.messageId === authorization.messageId &&
            String(diagnostic.fields.detail ?? '').startsWith('owned_process_unreaped ')
        )
      ).toBe(true);
      expect(logged.mock.calls.some(args => args[0] === OWNED_PROCESS_CLEANUP_UNREAPED)).toBe(true);

      attachRelease.resolve();
      expect(await attaching).toMatchObject({ ok: true });
    } finally {
      attachRelease.resolve();
      release.mockRestore();
      cleanup.mockRestore();
      requestRetirement.mockRestore();
      nativeRetire.mockRestore();
      logged.mockRestore();
    }
  });
});
