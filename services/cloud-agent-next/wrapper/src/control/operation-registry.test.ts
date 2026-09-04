import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SANDBOX_CONTROL_OPERATION_LIMIT,
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  sessionOperationLookupResultSchema,
} from '../../../src/shared/sandbox-control-protocol';
import {
  handleControlRequest,
  pruneControlOperations,
  type HandlerDeps,
} from './sandbox-control-handlers';
import {
  acknowledgeOperation,
  completion,
  createHandlerFixture,
  fakeKilo,
  operationAuthorization,
  promptPayload,
  session,
  type Completion,
} from './control-test-fixtures';
import { rememberAttachedRoot, resetSessionDirectoryState } from './session-directories';
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
    ).toMatchObject({ ok: false, error: { code: 'session_busy' } });
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
});
