import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS } from '../../../src/shared/sandbox-control-protocol.js';
import { handleControlRequest, type HandlerDeps } from './sandbox-control-handlers';
import { KILO_CONTROL_REQUEST_TIMEOUT_MS } from './sandbox-control-runtime';
import {
  acknowledgeOperation,
  completion,
  createHandlerFixture,
  fakeKilo,
  operationAuthorization,
  promptPayload,
  session,
} from './control-test-fixtures';
import { rememberAttachedRoot, resetSessionDirectoryState } from './session-directories';
import { resetDirectoryOperationState } from './worktree-operations';
import type { WorktreeKiloRuntime, WorktreeKiloRuntimes } from './worktree-runtime';
import { SessionOperation } from './session-operation';

let homeRoot: string;

beforeEach(() => {
  resetSessionDirectoryState();
  resetDirectoryOperationState();
  rememberAttachedRoot(session.kiloSessionId, session.directory);
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-operation-cleanup-test-'));
});

afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

function deps(overrides: Parameters<typeof createHandlerFixture>[1] = {}): HandlerDeps {
  return createHandlerFixture(homeRoot, overrides);
}

describe('SessionOperation cleanup', () => {
  it('expires by attempting targeted cleanup before runtime retirement', async () => {
    jest.useFakeTimers();
    const pending = Promise.withResolvers<ReturnType<typeof completion>>();
    const order: string[] = [];
    const client = fakeKilo({
      sendPrompt: () => pending.promise,
      abortSession: async () => {
        order.push('abort');
        return true;
      },
      getSessionStatuses: async () => ({ [session.kiloSessionId]: { type: 'idle' } }),
    });
    const runtime: WorktreeKiloRuntime = {
      scopeId: 'worktree_1',
      runtimeId: 'native_1',
      directory: session.directory,
      env: {},
      kiloClient: client,
      signal: new AbortController().signal,
    };
    const operation = new SessionOperation(
      session,
      undefined,
      { operation: 'session.prompt', payload: promptPayload, runtime },
      {
        isCurrent: () => true,
        getRuntime: () => runtime,
        verifyQuiescence: async () => false,
        retireRuntime: () => order.push('retire'),
        emitSessionEvent: () => {},
        onLocalCompletion: () => {},
        onCleanupConfirmed: () => {},
      }
    );

    await Promise.resolve();
    jest.advanceTimersByTime(SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['abort', 'retire']);
    pending.resolve(completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } }));
    await operation.done;
  });

  it('does not accept an idle root while a scoped native child is active', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof completion>>();
    let verified = 0;
    const client = fakeKilo({
      sendPrompt: () => pending.promise,
      abortSession: async () => true,
      getSessionStatuses: async () => ({
        [session.kiloSessionId]: { type: 'idle' },
        child: { type: 'busy' },
      }),
    });
    const runtime: WorktreeKiloRuntime = {
      scopeId: 'worktree_1',
      runtimeId: 'native_1',
      directory: session.directory,
      env: {},
      kiloClient: client,
      signal: new AbortController().signal,
    };
    const operation = new SessionOperation(
      session,
      undefined,
      { operation: 'session.prompt', payload: promptPayload, runtime },
      {
        isCurrent: () => true,
        getRuntime: () => runtime,
        verifyQuiescence: async () => {
          verified += 1;
          return true;
        },
        retireRuntime: () => {},
        emitSessionEvent: () => {},
        onLocalCompletion: () => {},
        onCleanupConfirmed: () => {},
      }
    );

    await Promise.resolve();
    expect(await operation.cleanupOwnedWork(Date.now() + 1_000)).toBe(false);
    expect(verified).toBe(0);
    pending.resolve(completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } }));
    await operation.done;
  });

  it('does not treat an abort acknowledgement or missing status as quiescence', async () => {
    let aborts = 0;
    const client = fakeKilo({
      sendPrompt: async () => completion(),
      abortSession: async () => {
        aborts += 1;
        return true;
      },
      getSessionStatuses: async () => ({}),
    });
    const runtime: WorktreeKiloRuntime = {
      scopeId: 'worktree_1',
      runtimeId: 'native_1',
      directory: session.directory,
      env: {},
      kiloClient: client,
      signal: new AbortController().signal,
    };
    const runtimes: WorktreeKiloRuntimes = {
      attach: () => ({
        ready: Promise.resolve(runtime),
        signal: runtime.signal,
        cleanup: async () => 'unconfirmed',
        commit: () => {},
        release: () => {},
      }),
      detach: () => true,
      deleteDirectory: async () => {},
      getRetained: () => runtime,
      retireRuntime: async () => 'unconfirmed',
      verifyQuiescence: async () => false,
      get: () => runtime,
      isHealthy: () => true,
      shutdown: () => {},
    };
    const handlerDeps = deps({ kiloClient: client, kiloRuntimes: runtimes });
    const authorization = operationAuthorization();
    await handleControlRequest(
      'session.prompt',
      session,
      promptPayload,
      handlerDeps,
      authorization
    );
    const stopped = await handleControlRequest(
      'session.abort',
      session,
      {
        messageId: authorization.messageId,
        operationId: '11111111-1111-4111-8111-111111111111',
        cleanupDeadlineAt: Date.now() + 1_000,
      },
      handlerDeps
    );
    expect(aborts).toBe(1);
    expect(stopped).toMatchObject({
      ok: true,
      result: { status: 'unconfirmed', quiescent: false },
    });
  });

  it('does not abort an active successor after a finished retained operation', async () => {
    let successorActive = false;
    const abort = jest.fn(async () => {
      if (successorActive) throw new Error('successor aborted');
      return true;
    });
    const client = fakeKilo({
      abortSession: abort,
      getSessionStatuses: async () =>
        successorActive ? { [session.kiloSessionId]: { type: 'busy' } } : {},
    });
    const runtime: WorktreeKiloRuntime = {
      scopeId: 'worktree_1',
      runtimeId: 'native_1',
      directory: session.directory,
      env: {},
      kiloClient: client,
      signal: new AbortController().signal,
    };
    const operation = new SessionOperation(
      session,
      undefined,
      { operation: 'session.prompt', payload: promptPayload, runtime },
      {
        isCurrent: () => true,
        getRuntime: () => runtime,
        verifyQuiescence: async () => false,
        retireRuntime: () => {},
        emitSessionEvent: () => {},
        onLocalCompletion: () => {},
        onCleanupConfirmed: () => {},
      }
    );

    await operation.done;
    successorActive = true;

    expect(await operation.cleanupOwnedWork(Date.now() + 1_000)).toBe(true);
    expect(abort).not.toHaveBeenCalled();
  });

  it('keeps an operation-only scoped Stop replay from retiring a successor native runtime', async () => {
    const successor = Promise.withResolvers<ReturnType<typeof completion>>();
    const successorStarted = Promise.withResolvers<void>();
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        sendPrompt: options => {
          if (options.messageId === 'message_b') {
            successorStarted.resolve();
            return successor.promise;
          }
          return Promise.resolve(completion());
        },
        getSessionStatuses: async () => ({}),
      }),
    });
    const authorizationA = operationAuthorization('session.prompt', 'message_a');
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, messageId: 'message_a' },
      handlerDeps,
      authorizationA
    );
    const operationA = handlerDeps.operations.retained()[0];
    if (!operationA) throw new Error('Missing first operation');
    await operationA.done;
    const stopA = {
      messageId: 'message_a',
      operationId: '11111111-1111-4111-8111-111111111111',
      cleanupDeadlineAt: Date.now() + 1_000,
    };

    expect(await handleControlRequest('session.abort', session, stopA, handlerDeps)).toMatchObject({
      ok: true,
      result: { status: 'aborted', quiescent: true },
    });
    expect(handlerDeps.kiloRuntimes?.get(session.directory)).toBeDefined();

    const authorizationB = operationAuthorization('session.prompt', 'message_b');
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, messageId: 'message_b' },
      handlerDeps,
      authorizationB
    );
    await successorStarted.promise;
    const operationB = handlerDeps.operations.active(session.kiloSessionId);

    expect(await handleControlRequest('session.abort', session, stopA, handlerDeps)).toMatchObject({
      ok: true,
      result: { status: 'aborted', quiescent: true },
    });
    expect(handlerDeps.operations.active(session.kiloSessionId)).toBe(operationB);
    expect(operationB?.signal.aborted).toBe(false);

    const stopB = handleControlRequest(
      'session.abort',
      session,
      {
        messageId: 'message_b',
        operationId: '22222222-2222-4222-8222-222222222222',
        cleanupDeadlineAt: Date.now() + 1_000,
      },
      handlerDeps
    );
    successor.resolve(completion({ name: 'MessageAbortedError', data: { message: 'cancelled' } }));

    expect(await stopB).toMatchObject({
      ok: true,
      result: {
        status: 'aborted',
        quiescent: true,
        runtimeRetired: true,
        nativeRuntimeId: 'native_1',
      },
    });
    expect(handlerDeps.kiloRuntimes?.get(session.directory)).toBeUndefined();
  });

  it('keeps a failed local attachment unconfirmed when its captured cleanup cannot prove retirement', async () => {
    let cleanupCalls = 0;
    const operation = new SessionOperation(
      session,
      undefined,
      {
        operation: 'session.attach',
        payload: {} as never,
        apply: async (_session, _payload, hooks) => {
          hooks.onMutation?.();
          hooks.onCleanupTarget?.(async () => {
            cleanupCalls += 1;
            return 'unconfirmed';
          });
          return {
            ok: false,
            error: { code: 'not_ready', message: 'attachment failed', retryable: true },
          };
        },
        onAttached: () => {},
      },
      {
        isCurrent: () => true,
        getRuntime: () => undefined,
        verifyQuiescence: async () => false,
        retireRuntime: () => {},
        emitSessionEvent: () => {},
        onLocalCompletion: () => {},
        onCleanupConfirmed: () => {},
      }
    );

    await operation.done;

    expect(await operation.cleanupOwnedWork(Date.now() + 1_000)).toBe(false);
    expect(cleanupCalls).toBe(1);
  });

  it('uses captured pre-client retirement proof after a failed local attachment', async () => {
    let cleanupCalls = 0;
    const operation = new SessionOperation(
      session,
      undefined,
      {
        operation: 'session.attach',
        payload: {} as never,
        apply: async (_session, _payload, hooks) => {
          hooks.onMutation?.();
          hooks.onCleanupTarget?.(async () => {
            cleanupCalls += 1;
            return 'retired';
          });
          return {
            ok: false,
            error: { code: 'not_ready', message: 'attachment failed', retryable: true },
          };
        },
        onAttached: () => {},
      },
      {
        isCurrent: () => true,
        getRuntime: () => undefined,
        verifyQuiescence: async () => false,
        retireRuntime: () => {},
        emitSessionEvent: () => {},
        onLocalCompletion: () => {},
        onCleanupConfirmed: () => {},
      }
    );

    await operation.done;

    expect(await operation.cleanupOwnedWork(Date.now() + 1_000)).toBe(true);
    expect(cleanupCalls).toBe(1);
  });

  it('keeps an unconfirmed native receipt after its original cleanup allowance expires', async () => {
    jest.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const original = Promise.withResolvers<ReturnType<typeof completion>>();
    const abortStarted = Promise.withResolvers<void>();
    let submissions = 0;
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        sendPrompt: () => {
          submissions++;
          started.resolve();
          return original.promise;
        },
        abortSession: async () => {
          abortStarted.resolve();
          return true;
        },
      }),
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    const authorization = operationAuthorization();
    await handleControlRequest(
      'session.prompt',
      session,
      promptPayload,
      handlerDeps,
      authorization
    );
    await started.promise;
    const record = handlerDeps.operations.retained()[0];
    if (!record) throw new Error('Missing operation record');
    record.cancel('Session aborted', 'cancelled');
    await abortStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(KILO_CONTROL_REQUEST_TIMEOUT_MS);
    await Promise.resolve();
    jest.advanceTimersByTime(0);
    await record.done;
    await record.waitForDelivery();
    const sealed = record.snapshot();

    expect(sealed.native.state).toBe('unknown');
    expect(sealed.delivery?.state).toBe('acknowledged');
    handlerDeps.operations.prune(Number.MAX_SAFE_INTEGER);
    expect(handlerDeps.operations.retained()).toEqual([record]);
    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        promptPayload,
        handlerDeps,
        authorization
      )
    ).toEqual({
      ok: true,
      result: { messageId: 'msg_1', status: 'existing', executionDeadlineAt: expect.any(Number) },
    });
    expect(submissions).toBe(1);

    original.resolve(completion());
    await Promise.resolve();
    expect(record.snapshot().native).toEqual(sealed.native);
    expect(record.snapshot().local).toEqual(sealed.local);
    expect(record.deliveryResult()).toEqual(sealed.delivery?.payload);
  });
});
