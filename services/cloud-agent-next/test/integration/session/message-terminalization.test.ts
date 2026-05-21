/**
 * Integration tests for message terminalization and stream-event emission.
 *
 * Phase 4 remediation: verify that `terminalizeSessionMessageOnce` is the
 * single centralized path and that idempotency prevents duplicate events
 * and duplicate callbacks.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import type { CallbackJob } from '../../../src/callbacks/types.js';
import {
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import { registerReadySession } from '../../helpers/session-setup.js';

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

const kiloSessionId = 'ses_term_callback';

async function seedAssistantMessageWithParent(
  state: DurableObjectState,
  doSessionId: string,
  opts: { messageId: string; parentId: string; parts: Record<string, unknown>[] }
): Promise<void> {
  const db = drizzle(state.storage, { logger: false });
  const events = createEventQueries(db, state.storage.sql);
  const now = Date.now();

  events.upsert({
    executionId: 'exc_term',
    sessionId: doSessionId,
    streamEventType: 'kilocode',
    payload: JSON.stringify({
      event: 'message.updated',
      properties: {
        info: {
          id: opts.messageId,
          role: 'assistant',
          sessionID: kiloSessionId,
          parentID: opts.parentId,
          time: { completed: now },
        },
      },
    }),
    timestamp: now,
    entityId: `message/${opts.messageId}`,
  });

  for (const [idx, part] of opts.parts.entries()) {
    events.upsert({
      executionId: 'exc_term',
      sessionId: doSessionId,
      streamEventType: 'kilocode',
      payload: JSON.stringify({
        event: 'message.part.updated',
        properties: {
          part: { ...part, messageID: opts.messageId, sessionID: kiloSessionId },
        },
      }),
      timestamp: now + 1 + idx,
      entityId: `part/${opts.messageId}/${String(part.id)}`,
    });
  }
}

describe('message terminalization and stream events', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    await Promise.all(ids.map(id => env.CLOUD_AGENT_SESSION.get(id).deleteSession()));
  });

  it('terminalization by messageId emits exactly one cloud.message.completed event', async () => {
    const userId = 'user_term_complete';
    const sessionId = 'agent_term_complete';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_term',
        kiloSessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-term',
      });

      const messageId = 'msg_018f1e2d3c4btermcmpabcd012';
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      // Call the centralized terminalization wrapper once
      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        assistantMessageId: 'asst_123',
        completionSource: 'assistant_message_event',
      });

      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const completedEvents = events.findByFilters({
        eventTypes: ['cloud.message.completed'],
      });

      return { completedEvents, messageId };
    });

    expect(result.completedEvents).toHaveLength(1);
    const payload = JSON.parse(result.completedEvents[0].payload);
    expect(payload.messageId).toBe(result.messageId);
    expect(payload.status).toBe('completed');
    expect(payload.assistantMessageId).toBe('asst_123');
    expect(payload.completionSource).toBe('assistant_message_event');
    expect(payload.delivery).toBe('sent');
    expect(payload.accepted).toBe(true);
  });

  it('terminalization by messageId emits exactly one cloud.message.failed event', async () => {
    const userId = 'user_term_failed';
    const sessionId = 'agent_term_failed';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_term_fail',
        kiloSessionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-fail',
      });

      const messageId = 'msg_018f1e2d3c4btermfailabcd01';
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'failed',
        reason: 'missing_assistant_reply',
        error: 'No reply',
        completionSource: 'idle_reconciliation',
      });

      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const failedEvents = events.findByFilters({
        eventTypes: ['cloud.message.failed'],
      });

      return { failedEvents, messageId };
    });

    expect(result.failedEvents).toHaveLength(1);
    const payload = JSON.parse(result.failedEvents[0].payload);
    expect(payload.messageId).toBe(result.messageId);
    expect(payload.status).toBe('failed');
    expect(payload.error).toBe('No reply');
    expect(payload.completionSource).toBe('idle_reconciliation');
  });

  it('duplicate terminalization does not emit duplicate stream events', async () => {
    const userId = 'user_term_dup';
    const sessionId = 'agent_term_dup';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_term_dup',
        kiloSessionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-dup',
      });

      const messageId = 'msg_018f1e2d3c4btermduplabcd01';
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      // First terminalization
      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });

      // Duplicate terminalization with different params (should be ignored)
      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'failed',
        reason: 'x',
        completionSource: 'wrapper_failure',
      });

      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const completedEvents = events.findByFilters({
        eventTypes: ['cloud.message.completed'],
      });
      const failedEvents = events.findByFilters({
        eventTypes: ['cloud.message.failed'],
      });

      return { completedEvents, failedEvents };
    });

    expect(result.completedEvents).toHaveLength(1);
    expect(result.failedEvents).toHaveLength(0);
  });

  it('duplicate terminalization does not enqueue duplicate callbacks', async () => {
    const userId = 'user_term_dup_cb';
    const sessionId = 'agent_term_dup_cb';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const queue = createCapturedQueue();

    const result = await runInDurableObject(stub, async instance => {
      injectCallbackQueue(instance, queue);

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_term_dup_cb',
        kiloSessionId: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-dup-cb',
      });

      const messageId = 'msg_018f1e2d3c4btermdupcbabcd0';
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

      // First terminalization records the batch callback candidate.
      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });

      // Duplicate terminalization does not create another representative callback.
      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });

      return { captured: queue.captured };
    });

    expect(result.captured).toHaveLength(1);
    const [job] = result.captured;
    expect(job.payload.messageId).toBe('msg_018f1e2d3c4btermdupcbabcd0');
    expect(job.payload.status).toBe('completed');
    expect(job.target.url).toBe('https://example.com/callback');
  });

  it('terminalization emits cloud.message.interrupted for interrupted kind', async () => {
    const userId = 'user_term_int';
    const sessionId = 'agent_term_int';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_term_int',
        kiloSessionId: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-int',
      });

      const messageId = 'msg_018f1e2d3c4btermintabcd012';
      const acceptedState: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_run1',
      };
      await putSessionMessageState(instance.ctx.storage, acceptedState);

      await (instance as any).terminalizeSessionMessageOnce(messageId, {
        kind: 'interrupted',
        error: 'User interrupted',
        completionSource: 'interrupt',
      });

      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const failedEvents = events.findByFilters({
        eventTypes: ['cloud.message.failed'],
      });

      return { failedEvents, messageId };
    });

    expect(result.failedEvents).toHaveLength(1);
    const payload = JSON.parse(result.failedEvents[0].payload);
    expect(payload.messageId).toBe(result.messageId);
    expect(payload.status).toBe('interrupted');
    expect(payload.error).toBe('User interrupted');
    expect(payload.completionSource).toBe('interrupt');
  });

  it('completed callback resolves assistant text by matching parentID, not latest assistant', async () => {
    const userId = 'user_term_corr';
    const sessionId = 'agent_term_corr';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const queue = createCapturedQueue();

    const result = await runInDurableObject(stub, async (instance, state) => {
      injectCallbackQueue(instance, queue);

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_term_corr',
        kiloSessionId,
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-corr',
        callbackTarget: { url: 'https://example.com/callback' },
      });

      const messageId = 'msg_018f1e2d3c4btermcorrabcd01';

      // Seed a later assistant message with a DIFFERENT parentID
      // If the code incorrectly used getLatestAssistantMessage, this text would appear.
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'msg_latest_wrong_00000000001',
        parentId: 'msg_some_other_message_00001',
        parts: [
          { id: 'part_00000000000000000000000001', type: 'text', text: 'Wrong latest answer' },
        ],
      });

      // Seed the correct assistant message with matching parentID
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'msg_correct_reply_00000000001',
        parentId: messageId,
        parts: [
          { id: 'part_00000000000000000000000002', type: 'text', text: 'Correct ' },
          { id: 'part_00000000000000000000000003', type: 'text', text: 'answer' },
        ],
      });

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
        assistantMessageId: 'msg_correct_reply_00000000001',
        completionSource: 'assistant_message_event',
      });
      await (instance as any).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });

      return { captured: queue.captured };
    });

    expect(result.captured).toHaveLength(1);
    const [job] = result.captured;
    expect(job.payload.status).toBe('completed');
    expect(job.payload.messageId).toBe('msg_018f1e2d3c4btermcorrabcd01');
    expect(job.payload.lastAssistantMessageText).toBe('Correct answer');
  });

  it('completed callback omits assistant text when no matching parentID reply exists', async () => {
    const userId = 'user_term_missing';
    const sessionId = 'agent_term_missing';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const queue = createCapturedQueue();

    const result = await runInDurableObject(stub, async (instance, state) => {
      injectCallbackQueue(instance, queue);

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_term_missing',
        kiloSessionId,
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-missing',
        callbackTarget: { url: 'https://example.com/callback' },
      });

      const messageId = 'msg_018f1e2d3c4btermmissabcd01';

      // Seed an assistant message for a DIFFERENT parentID
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'msg_other_reply_00000000001',
        parentId: 'msg_some_other_message_00001',
        parts: [
          {
            id: 'part_00000000000000000000000001',
            type: 'text',
            text: 'Answer for another message',
          },
        ],
      });

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

      return { captured: queue.captured };
    });

    expect(result.captured).toHaveLength(1);
    const [job] = result.captured;
    expect(job.payload.status).toBe('completed');
    expect(job.payload.messageId).toBe('msg_018f1e2d3c4btermmissabcd01');
    expect(job.payload.lastAssistantMessageText).toBeUndefined();
  });
});
