import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    ).toEqual({ ok: true, result: { messageId: 'msg_1', status: 'existing' } });
    expect(submissions).toBe(1);

    original.resolve(completion());
    await Promise.resolve();
    expect(record.snapshot().native).toEqual(sealed.native);
    expect(record.snapshot().local).toEqual(sealed.local);
    expect(record.deliveryResult()).toEqual(sealed.delivery?.payload);
  });
});
