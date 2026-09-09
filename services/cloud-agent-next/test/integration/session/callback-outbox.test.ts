/**
 * Integration tests for message-based callback outbox behavior.
 *
 * Phase 10 remediation: verify that missing callbackTarget or missing
 * CALLBACK_QUEUE records observable state instead of silently returning.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import type { CallbackJob } from '../../../src/callbacks/types.js';
import {
  getSessionMessageState,
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import { registerReadySession } from '../../helpers/session-setup.js';
import { createMessageId } from '../../../src/session/message-id.js';

type CapturedQueue = {
  send: (job: CallbackJob) => Promise<void>;
  captured: CallbackJob[];
};

function createCapturedQueue(): CapturedQueue {
  const captured: CallbackJob[] = [];
  return {
    captured,
    send: async (job: CallbackJob) => {
      captured.push(job);
    },
  };
}

function injectCallbackQueue(instance: CloudAgentSession, queue: CapturedQueue): void {
  (instance as unknown as { env: { CALLBACK_QUEUE: CapturedQueue } }).env.CALLBACK_QUEUE = queue;
}

function removeCallbackQueue(instance: CloudAgentSession): void {
  (
    instance as unknown as { env: { CALLBACK_QUEUE: CapturedQueue | undefined } }
  ).env.CALLBACK_QUEUE = undefined;
}

// Registered sessions leave dispatch, alarm, and fire-and-forget publication
// work in the session DO. Interrupt every session a test touched, clear its
// alarm, and drain its publication tail, or that work wakes after this file
// closes and its logs race the vitest worker shutdown as pending
// onUserConsoleLog rejections (EnvironmentTeardownError).
const touchedSessions = new Set<string>();

function sessionStub(userId: string, sessionId: string) {
  const sessionName = `${userId}:${sessionId}`;
  touchedSessions.add(sessionName);
  return env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName));
}

afterEach(async () => {
  for (const sessionName of touchedSessions) {
    await runInDurableObject(
      env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName)),
      async (instance, state) => {
        try {
          await instance.interruptExecution();
        } catch {
          // A session that never registered has no work to interrupt.
        }
        await state.storage.deleteAlarm();
        const publicationTail = (instance as any).publicExtensionPublicationTail as
          | Promise<unknown>
          | undefined;
        await publicationTail?.catch(() => undefined);
      }
    ).catch(() => undefined);
  }
  touchedSessions.clear();
});

describe('callback outbox — missing target or queue', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    await Promise.all(
      ids.map(id =>
        runInDurableObject(env.CLOUD_AGENT_SESSION.get(id), instance =>
          instance.ctx.storage.deleteAll()
        )
      )
    );
  });

  it('records callbackLastError when callbackTarget is missing on a callback-required message', async () => {
    const userId = 'user_cb_no_target';
    const sessionId = 'agent_cb_no_target';
    const stub = sessionStub(userId, sessionId);

    const queue = createCapturedQueue();

    await runInDurableObject(stub, async instance => {
      injectCallbackQueue(instance, queue);

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_cb_no_target',
        kiloSessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-no-target',
      });

      const messageId = createMessageId();
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
        callbackRequired: true,
        // callbackTarget intentionally omitted
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });

      const finalState = await getSessionMessageState(instance.ctx.storage, messageId);
      expect(finalState?.callbackLastError).toBe('Missing callback target');
      expect(finalState?.callbackAttempts).toBe(1);
    });

    expect(queue.captured).toHaveLength(0);
  });

  it('records callbackLastError when CALLBACK_QUEUE binding is missing', async () => {
    const userId = 'user_cb_no_queue';
    const sessionId = 'agent_cb_no_queue';
    const stub = sessionStub(userId, sessionId);

    await runInDurableObject(stub, async instance => {
      removeCallbackQueue(instance);

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_cb_no_queue',
        kiloSessionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-no-queue',
      });

      const messageId = createMessageId();
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
        callbackRequired: true,
        callbackTarget: { url: 'https://example.com/callback' },
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });

      const finalState = await getSessionMessageState(instance.ctx.storage, messageId);
      expect(finalState?.callbackLastError).toBe('Callback queue not available');
      expect(finalState?.callbackAttempts).toBe(1);
    });
  });

  it('records callbackRetryAt when queue send throws', async () => {
    const userId = 'user_cb_retry';
    const sessionId = 'agent_cb_retry';
    const stub = sessionStub(userId, sessionId);

    const failingQueue: CapturedQueue = {
      captured: [],
      send: async () => {
        throw new Error('queue down');
      },
    };

    const before = Date.now();

    await runInDurableObject(stub, async instance => {
      injectCallbackQueue(instance, failingQueue);

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_cb_retry',
        kiloSessionId: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-retry',
      });

      const messageId = createMessageId();
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
        callbackRequired: true,
        callbackTarget: { url: 'https://example.com/callback' },
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });

      const finalState = await getSessionMessageState(instance.ctx.storage, messageId);
      expect(finalState?.callbackLastError).toBe('queue down');
      expect(finalState?.callbackAttempts).toBe(1);
      expect(finalState?.callbackRetryAt).toBeGreaterThanOrEqual(before + 25_000);
      expect(finalState?.callbackRetryAt).toBeLessThanOrEqual(Date.now() + 35_000);
    });

    expect(failingQueue.captured).toHaveLength(0);
  });

  it('does not record error when callback is not required and target is missing', async () => {
    const userId = 'user_cb_optional';
    const sessionId = 'agent_cb_optional';
    const stub = sessionStub(userId, sessionId);

    await runInDurableObject(stub, async instance => {
      removeCallbackQueue(instance);

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_cb_optional',
        kiloSessionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-optional',
      });

      const messageId = createMessageId();
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
        callbackRequired: false,
        // callbackTarget omitted
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });

      const finalState = await getSessionMessageState(instance.ctx.storage, messageId);
      expect(finalState?.callbackLastError).toBeUndefined();
      expect(finalState?.callbackAttempts).toBeUndefined();
    });
  });

  it('collapses a multi-message idle batch into the last callback-relevant message', async () => {
    const userId = 'user_cb_batch';
    const sessionId = 'agent_cb_batch';
    const stub = sessionStub(userId, sessionId);
    const queue = createCapturedQueue();

    const result = await runInDurableObject(stub, async instance => {
      injectCallbackQueue(instance, queue);
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_cb_batch',
        kiloSessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-batch',
      });

      const firstMessageId = createMessageId();
      const secondMessageId = createMessageId();
      await putSessionMessageState(instance.ctx.storage, {
        messageId: firstMessageId,
        status: 'accepted',
        prompt: 'first',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_batch',
        callbackRequired: true,
        callbackTarget: { url: 'https://example.com/first' },
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: secondMessageId,
        status: 'accepted',
        prompt: 'second',
        createdAt: Date.now() + 1,
        acceptedAt: Date.now() + 1,
        wrapperRunId: 'wr_batch',
        callbackRequired: true,
        callbackTarget: { url: 'https://example.com/second' },
      });

      await (instance as any).terminalizeSessionMessageOnce(firstMessageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });
      const callbackCountBeforeIdle = queue.captured.length;

      await (instance as any).terminalizeSessionMessageOnce(secondMessageId, {
        kind: 'failed',
        reason: 'assistant_error',
        error: 'provider failed',
        completionSource: 'assistant_message_event',
        failureStage: 'agent_activity',
        failureCode: 'assistant_error',
        safeFailureMessage: 'Assistant request failed',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });

      return { callbackCountBeforeIdle, secondMessageId };
    });

    expect(result.callbackCountBeforeIdle).toBe(0);
    expect(queue.captured).toHaveLength(1);
    expect(queue.captured[0].target.url).toBe('https://example.com/second');
    expect(queue.captured[0].payload.messageId).toBe(result.secondMessageId);
    expect(queue.captured[0].payload.executionId).toBe(result.secondMessageId);
    expect(queue.captured[0].payload.idempotencyKey).toBe(result.secondMessageId);
    expect(queue.captured[0].payload.status).toBe('failed');
    expect(queue.captured[0].payload.errorMessage).toBe('Assistant request failed');
    expect(queue.captured[0].payload.failure).toEqual({
      stage: 'agent_activity',
      code: 'assistant_error',
      message: 'Assistant request failed',
    });
  });

  it('includes idempotencyKey set to messageId in callback payload', async () => {
    const userId = 'user_cb_idempotency';
    const sessionId = 'agent_cb_idempotency';
    const stub = sessionStub(userId, sessionId);

    const queue = createCapturedQueue();

    await runInDurableObject(stub, async instance => {
      injectCallbackQueue(instance, queue);

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_cb_idempotency',
        kiloSessionId: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-idempotency',
      });

      const messageId = createMessageId();
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
        callbackRequired: true,
        callbackTarget: { url: 'https://example.com/callback' },
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });

      const finalState = await getSessionMessageState(instance.ctx.storage, messageId);
      expect(finalState?.callbackEnqueuedAt).toBeGreaterThan(0);
    });

    expect(queue.captured).toHaveLength(1);
    expect(queue.captured[0].payload.idempotencyKey).toBeDefined();
    const payload = queue.captured[0].payload;
    expect(payload.idempotencyKey).toBe(payload.messageId);
    expect(payload.executionId).toBe(payload.messageId);
  });
});
