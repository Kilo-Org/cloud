import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
  sessionOperationDeliverySchema,
  type SessionEventPayload,
  type SessionOperationAck,
  type SessionOperationDelivery,
} from '../../../src/shared/sandbox-control-protocol';
import type { AutoCommitResult } from '../auto-commit';
import {
  buildHeartbeatPayload,
  handleControlRequest,
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
} from './control-test-fixtures';
import { rememberAttachedRoot, resetSessionDirectoryState } from './session-directories';
import { resetDirectoryOperationState } from './worktree-operations';

let homeRoot: string;

beforeEach(() => {
  resetSessionDirectoryState();
  resetDirectoryOperationState();
  rememberAttachedRoot(session.kiloSessionId, session.directory);
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-operation-test-'));
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

describe('operation results and delivery', () => {
  it.each([{ data: undefined }, { data: null }, { data: [] }, { data: 'invalid' }, { data: 1 }])(
    'rejects malformed finalization notification data without changing the producer result: %j',
    async ({ data }) => {
      const notifications: SessionEventPayload[] = [];
      const handlerDeps = deps({
        runAutoCommit: async options => {
          options.onEvent({
            streamEventType: 'autocommit_completed',
            data,
            timestamp: new Date().toISOString(),
          });
          return { success: true };
        },
        emitSessionEvent: (_session, event) => notifications.push(event),
        sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
      });
      await handleControlRequest(
        'session.prompt',
        session,
        { ...promptPayload, finalization: { autoCommit: true } },
        handlerDeps,
        operationAuthorization()
      );
      const record = onlyOperation(handlerDeps);
      await record.done;
      await record.waitForDelivery();
      expect(record.snapshot().finalization.autoCommit).toEqual({
        state: 'completed',
        result: { success: true },
      });
      expect(record.snapshot().outcome?.status).toBe('completed');
      expect(record.snapshot().events).toEqual([]);
      expect(record.snapshot().delivery?.payload.events).toEqual([]);
      expect(record.snapshot().delivery?.state).toBe('acknowledged');
      expect(notifications.filter(event => event.type === 'autocommit_completed')).toEqual([]);
    }
  );

  it('aborts an already-awaiting finalizer and retains its late original result without false quiescence', async () => {
    const entered = Promise.withResolvers<void>();
    const finalized = Promise.withResolvers<AutoCommitResult>();
    let finalizerSignal: AbortSignal | undefined;
    const handlerDeps = deps({
      runAutoCommit: async options => {
        finalizerSignal = options.signal;
        entered.resolve();
        const result = await finalized.promise;
        options.onEvent({
          streamEventType: 'autocommit_completed',
          data: {
            success: result.success,
            commitHash: 'original-commit',
            messageId: options.messageId,
          },
          timestamp: new Date().toISOString(),
        });
        return result;
      },
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    const authorization = operationAuthorization();
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, finalization: { autoCommit: true } },
      handlerDeps,
      authorization
    );
    await entered.promise;
    const record = onlyOperation(handlerDeps);
    record.cancel('Late work cancellation', 'cancelled');
    expect(finalizerSignal?.aborted).toBe(true);
    expect(record.snapshot().local).toBeUndefined();
    expect(handlerDeps.operations.active(session.kiloSessionId)).toBe(record);
    finalized.resolve({ success: true });
    await record.done;
    await record.waitForDelivery();
    expect(record.snapshot().finalization.autoCommit).toEqual({
      state: 'completed',
      result: { success: true },
    });
    expect(record.snapshot().events).toEqual([
      {
        type: 'autocommit_completed',
        properties: { success: true, commitHash: 'original-commit', messageId: 'assistant_1' },
        timestamp: expect.any(String),
      },
    ]);
    expect(record.snapshot().native.completion).toEqual(completion().info);
    expect(record.snapshot().outcome?.status).toBe('completed');
    expect(handlerDeps.operations.counts().active).toBe(0);
  });

  it('releases execution before ACK and does not let Stop or an old execution timer rewrite completion', async () => {
    const acknowledgement = Promise.withResolvers<SessionOperationAck>();
    const sending = Promise.withResolvers<SessionOperationDelivery>();
    const handlerDeps = deps({
      sendOperationResult: (_session, delivery) => {
        sending.resolve(delivery);
        return acknowledgement.promise;
      },
    });
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    const authorization = operationAuthorization();
    const timers = spyOn(globalThis, 'setTimeout');
    const cleared = spyOn(globalThis, 'clearTimeout');
    try {
      await handleControlRequest(
        'session.prompt',
        session,
        promptPayload,
        handlerDeps,
        authorization
      );
      const record = onlyOperation(handlerDeps);
      await record.done;
      const delivery = await sending.promise;
      const original = structuredClone(record.snapshot().local);
      expect(cleared).toHaveBeenCalledWith(timers.mock.results[0]?.value);
      expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
        state: 'idle',
        pendingMessages: 0,
      });
      setSystemTime(Date.now() + SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS + 1);
      expect(record.snapshot().delivery?.payload).toEqual(delivery);
      acknowledgement.resolve(await acknowledgeOperation(delivery));
      await record.waitForDelivery();
      expect(record.snapshot().local).toEqual(original);
      expect(record.snapshot().outcome).toEqual({ messageId: 'msg_1', status: 'completed' });
      expect(handlerDeps.operations.counts().active).toBe(0);
    } finally {
      for (const record of handlerDeps.operations.retained()) {
        const delivery = record.deliveryResult();
        if (delivery) {
          acknowledgement.resolve(await acknowledgeOperation(delivery));
          await record.waitForDelivery();
        }
      }
      timers.mockRestore();
      cleared.mockRestore();
    }
  });

  it('drains a retained result before completing sandbox shutdown', async () => {
    const acknowledgement = Promise.withResolvers<SessionOperationAck>();
    const sending = Promise.withResolvers<SessionOperationDelivery>();
    const handlerDeps = deps({
      sendOperationResult: (_session, delivery) => {
        sending.resolve(delivery);
        return acknowledgement.promise;
      },
    });
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
    const delivery = await sending.promise;
    let settled = false;
    const shutdown = handleControlRequest('sandbox.shutdown', undefined, {}, handlerDeps).then(
      result => {
        settled = true;
        return result;
      }
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledgement.resolve(await acknowledgeOperation(delivery));
    expect(await shutdown).toEqual({ ok: true, result: { shuttingDown: true } });
    await record.waitForDelivery();
  });

  it('retires held delivery only for an exact lookup-driven durable acknowledgement', async () => {
    const held = Promise.withResolvers<SessionOperationAck>();
    const sending = Promise.withResolvers<SessionOperationDelivery>();
    const handlerDeps = deps({
      sendOperationResult: (_session, delivery) => {
        sending.resolve(delivery);
        return held.promise;
      },
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
    const record = onlyOperation(handlerDeps);
    await record.done;
    const delivery = await sending.promise;
    const ack = await acknowledgeOperation(delivery);
    try {
      expect(
        await handleControlRequest(
          'session.operation.ack',
          session,
          { ...ack, resultHash: '0'.repeat(64) },
          handlerDeps
        )
      ).toMatchObject({ ok: false });
      expect(
        await handleControlRequest(
          'session.operation.ack',
          session,
          { ...ack, authorization: { ...authorization, wrapperInstanceId: crypto.randomUUID() } },
          handlerDeps
        )
      ).toMatchObject({ ok: false });
      expect(record.snapshot().delivery?.state).toBe('pending');
      record.cancel('Late work cancellation', 'cancelled');
      expect(
        await handleControlRequest('session.operation.ack', session, ack, handlerDeps)
      ).toEqual({ ok: true, result: { acknowledged: true } });
      await record.waitForDelivery();
      expect(record.snapshot().delivery?.acknowledgement).toEqual(ack);
      expect(record.snapshot().delivery?.state).toBe('acknowledged');
      expect(record.snapshot().outcome?.status).toBe('completed');
      expect(handlerDeps.operations.counts().active).toBe(0);
    } finally {
      held.resolve(ack);
    }
  });

  it.each(['prompt', 'command', 'compact'] as const)(
    'does not replay an unknown native %s outcome',
    async kind => {
      let submissions = 0;
      let commits = 0;
      const unavailable = async () => {
        submissions++;
        throw new Error('Mutation response unavailable');
      };
      const handlerDeps = deps({
        kiloClient: fakeKilo({
          sendPrompt: unavailable,
          sendCommand: unavailable,
          summarizeSession: unavailable,
        }),
        runAutoCommit: async () => {
          commits++;
          return { success: true };
        },
        sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
      });
      rememberAttachedRoot(session.kiloSessionId, session.directory);
      const authorization = operationAuthorization();
      const payload = {
        ...promptPayload,
        turn:
          kind === 'prompt'
            ? promptPayload.turn
            : {
                type: 'command',
                command: kind === 'compact' ? 'compact' : 'review',
                arguments: '',
              },
        finalization: { autoCommit: true },
      };
      await handleControlRequest('session.prompt', session, payload, handlerDeps, authorization);
      const record = onlyOperation(handlerDeps);
      await record.done;
      await record.waitForDelivery();
      expect(record.snapshot().native.state).toBe('unknown');
      expect(record.snapshot().outcome).toMatchObject({
        status: 'failed',
        reason: 'Kilo execution outcome is unconfirmed',
      });
      await handleControlRequest('session.prompt', session, payload, handlerDeps, authorization);
      expect(submissions).toBe(1);
      expect(commits).toBe(0);
    }
  );

  it('stops work after a cancelled wait but gives retained delivery a separate lifetime', async () => {
    const materialized = Promise.withResolvers<void>();
    let submissions = 0;
    let deliveryWasCancelled: boolean | undefined;
    const handlerDeps = deps({
      materializeAttachments: async message => {
        await materialized.promise;
        return message;
      },
      kiloClient: fakeKilo({
        sendPrompt: async () => {
          submissions++;
          return completion();
        },
      }),
      sendOperationResult: (_session, delivery, signal) => {
        deliveryWasCancelled = signal.aborted;
        return acknowledgeOperation(delivery);
      },
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
    const record = onlyOperation(handlerDeps);
    record.cancel('Session aborted', 'cancelled');
    materialized.resolve();
    await record.done;
    await record.waitForDelivery();
    expect(record.signal.aborted).toBe(true);
    expect(deliveryWasCancelled).toBe(false);
    expect(record.snapshot().outcome?.status).toBe('cancelled');
    expect(submissions).toBe(0);
  });

  it('normalizes a late native MessageAbortedError to cancelled before sealing', async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        sendPrompt: async () => {
          entered.resolve();
          await aborted.promise;
          return completion({ name: 'MessageAbortedError', data: { message: 'User aborted' } });
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
    await entered.promise;
    const record = onlyOperation(handlerDeps);
    record.cancel('Session aborted', 'cancelled');
    aborted.resolve();
    await record.done;
    await record.waitForDelivery();
    expect(record.snapshot().outcome).toMatchObject({
      status: 'cancelled',
      reason: 'Kilo execution ended with MessageAbortedError',
    });
    expect(record.snapshot().native.completion?.error?.name).toBe('MessageAbortedError');
    expect(record.snapshot().delivery?.state).toBe('acknowledged');
  });

  it.each([
    [undefined, 'completed'],
    [{ name: 'MessageAbortedError', data: { message: 'cancelled' } }, 'cancelled'],
  ] as const)(
    'waits for a native %s result that arrives after the abort acknowledgement',
    async (nativeError, status) => {
      const started = Promise.withResolvers<void>();
      const original = Promise.withResolvers<ReturnType<typeof completion>>();
      const abortAcknowledged = Promise.withResolvers<void>();
      const handlerDeps = deps({
        kiloClient: fakeKilo({
          sendPrompt: () => {
            started.resolve();
            return original.promise;
          },
          abortSession: async () => {
            abortAcknowledged.resolve();
            setTimeout(() => original.resolve(completion(nativeError)), 125);
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
      const record = onlyOperation(handlerDeps);
      const aborting = handleControlRequest(
        'session.abort',
        session,
        { messageId: 'msg_1' },
        handlerDeps
      );
      await abortAcknowledged.promise;
      expect(record.locallyComplete).toBe(false);
      expect(await aborting).toEqual({ ok: true, result: { status: 'aborted' } });
      await record.waitForDelivery();

      expect(record.snapshot().outcome?.status).toBe(status);
      expect(record.snapshot().delivery?.state).toBe('acknowledged');
    }
  );

  it.each([
    ['false', () => false],
    [
      'throws',
      () => {
        throw new Error('live event transport unavailable');
      },
    ],
  ])('retains a bounded completion when live publication %s', async (_name, emitSessionEvent) => {
    let finalizations = 0;
    const handlerDeps = deps({
      runAutoCommit: async options => {
        finalizations++;
        for (let index = 0; index < 8; index++) {
          options.onEvent({
            streamEventType: 'status',
            data: { message: `Optional status ${index}`, messageId: options.messageId },
            timestamp: new Date().toISOString(),
          });
        }
        options.onEvent({
          streamEventType: 'autocommit_completed',
          data: {
            success: true,
            messageId: options.messageId,
            commitHash: 'commit_123',
            message: 'push failed '.repeat(100_000),
            commitMessage: 'subject '.repeat(100_000),
            ignoredMetadata: { tooLarge: 'metadata '.repeat(100_000) },
          },
          timestamp: new Date().toISOString(),
        });
        return { success: true };
      },
      emitSessionEvent: () => emitSessionEvent(),
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    const authorization = operationAuthorization();
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, finalization: { autoCommit: true } },
      handlerDeps,
      authorization
    );
    const record = onlyOperation(handlerDeps);
    await record.done;
    await record.waitForDelivery();
    const delivery = record.deliveryResult();
    if (!delivery) throw new Error('Missing retained completion');
    const completionEvent = record
      .snapshot()
      .events.find(event => event.type === 'autocommit_completed');

    expect(record.snapshot().outcome?.status).toBe('completed');
    expect(finalizations).toBe(1);
    expect(completionEvent).toMatchObject({
      properties: {
        success: true,
        messageId: 'assistant_1',
        commitHash: 'commit_123',
      },
    });
    expect(String(completionEvent?.properties.message).length).toBeLessThanOrEqual(4_096);
    expect(String(completionEvent?.properties.commitMessage).length).toBeLessThanOrEqual(4_096);
    expect(completionEvent?.properties).not.toHaveProperty('ignoredMetadata');
    expect(sessionOperationDeliverySchema.parse(delivery)).toEqual(delivery);

    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        { ...promptPayload, finalization: { autoCommit: true } },
        handlerDeps,
        authorization
      )
    ).toEqual({ ok: true, result: { messageId: 'msg_1', status: 'existing' } });
    expect(finalizations).toBe(1);
  });

  it('publishes auto-commit progress while retaining its completion', async () => {
    const events: SessionEventPayload[] = [];
    let finalizations = 0;
    const handlerDeps = deps({
      runAutoCommit: async options => {
        finalizations++;
        options.onEvent({
          streamEventType: 'autocommit_started',
          data: { message: 'Committing changes', messageId: options.messageId },
          timestamp: new Date().toISOString(),
        });
        options.onEvent({
          streamEventType: 'autocommit_completed',
          data: {
            success: true,
            message: 'Changes committed',
            messageId: options.messageId,
            commitHash: 'commit_123',
          },
          timestamp: new Date().toISOString(),
        });
        return { success: true };
      },
      emitSessionEvent: (_session, event) => events.push(event),
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, finalization: { autoCommit: true } },
      handlerDeps,
      operationAuthorization()
    );
    const record = onlyOperation(handlerDeps);
    await record.done;
    await record.waitForDelivery();
    const delivery = record.deliveryResult();
    if (!delivery) throw new Error('Missing retained completion');

    expect(events.map(event => event.type)).toEqual(['autocommit_started', 'autocommit_completed']);
    expect(record.snapshot().events).toEqual([
      expect.objectContaining({
        type: 'autocommit_completed',
        properties: expect.objectContaining({ commitHash: 'commit_123' }),
      }),
    ]);
    expect(record.snapshot().outcome?.status).toBe('completed');
    expect(sessionOperationDeliverySchema.parse(delivery)).toEqual(delivery);
    expect(finalizations).toBe(1);
  });

  it('retains a terminal preparation action after progress fills the optional slots', async () => {
    const handlerDeps = deps({
      applyAttach: async (_session, _payload, hooks) => {
        for (let revision = 0; revision < 64; revision++) {
          hooks.emitPreparing?.({
            version: 2,
            attemptId: 'prepare_msg_1',
            triggerMessageId: 'msg_1',
            revision,
            timestamp: revision,
            step: 'workspace_setup',
            message: `Preparing ${revision}`,
            action: 'step_started',
            stepId: `step_${revision}`,
            kind: 'phase',
            label: 'Setup',
          });
        }
        hooks.emitPreparing?.({
          version: 2,
          attemptId: 'prepare_msg_1',
          triggerMessageId: 'msg_1',
          revision: 64,
          timestamp: 64,
          step: 'workspace_setup',
          message: 'Preparation completed',
          action: 'attempt_completed',
        });
        return { ok: true, result: { attached: true } };
      },
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    const authorization = operationAuthorization('session.attach');
    await handleControlRequest('session.attach', session, {}, handlerDeps, authorization);
    const record = onlyOperation(handlerDeps);
    await record.done;
    await record.waitForDelivery();
    const delivery = record.deliveryResult();
    if (!delivery) throw new Error('Missing retained preparation');

    expect(record.snapshot().preparing).toHaveLength(57);
    expect(record.snapshot().preparing).toContainEqual(
      expect.objectContaining({ action: 'attempt_completed', message: 'Preparation completed' })
    );
    expect(sessionOperationDeliverySchema.parse(delivery)).toEqual(delivery);
  });

  it('retains a bounded failed completion without changing its failed outcome', async () => {
    const handlerDeps = deps({
      runAutoCommit: async options => {
        options.onEvent({
          streamEventType: 'autocommit_completed',
          data: {
            success: false,
            messageId: options.messageId,
            commitHash: 'commit_123',
            message: 'git push failed '.repeat(100_000),
          },
          timestamp: new Date().toISOString(),
        });
        return { success: false, error: 'git push failed' };
      },
      sendOperationResult: (_session, delivery) => acknowledgeOperation(delivery),
    });
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, finalization: { autoCommit: true } },
      handlerDeps,
      operationAuthorization()
    );
    const record = onlyOperation(handlerDeps);
    await record.done;
    await record.waitForDelivery();

    expect(record.snapshot().outcome).toMatchObject({
      status: 'failed',
      reason: 'Auto-commit failed',
    });
    expect(record.snapshot().events).toContainEqual(
      expect.objectContaining({
        type: 'autocommit_completed',
        properties: expect.objectContaining({ success: false, commitHash: 'commit_123' }),
      })
    );
  });
});
