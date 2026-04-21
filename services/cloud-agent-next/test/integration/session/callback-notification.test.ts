/**
 * Integration tests for callback notifications and the latest assistant
 * message text forwarded to the callback queue.
 *
 * Covers two gaps left by router.test.ts and events.test.ts:
 * 1. `lastAssistantMessageText` is populated on `completed` callbacks and
 *    omitted on `failed` / `interrupted` callbacks.
 * 2. Assistant messages containing only non-text parts (e.g. tool calls)
 *    produce no `lastAssistantMessageText` rather than an empty string.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import type { CallbackJob } from '../../../src/callbacks/types.js';
import type { ExecutionId } from '../../../src/types/ids.js';

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
  // CALLBACK_QUEUE is not bound in the test wrangler config; inject a
  // capturing fake onto the DO's env so enqueueCallbackNotification runs.
  (instance as unknown as { env: { CALLBACK_QUEUE: CapturedQueue } }).env.CALLBACK_QUEUE = queue;
}

const kiloSessionId = 'ses_root';

async function seedAssistantMessage(
  state: DurableObjectState,
  doSessionId: string,
  opts: { messageId: string; parts: Record<string, unknown>[] }
): Promise<void> {
  const db = drizzle(state.storage, { logger: false });
  const events = createEventQueries(db, state.storage.sql);
  const now = Date.now();

  events.upsert({
    executionId: 'exc_cb',
    sessionId: doSessionId,
    streamEventType: 'kilocode',
    payload: JSON.stringify({
      event: 'message.updated',
      properties: {
        info: { id: opts.messageId, role: 'assistant', sessionID: kiloSessionId },
      },
    }),
    timestamp: now,
    entityId: `message/${opts.messageId}`,
  });

  for (const [idx, part] of opts.parts.entries()) {
    events.upsert({
      executionId: 'exc_cb',
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

async function prepareSessionWithCallback(
  instance: CloudAgentSession,
  sessionId: string,
  userId: string
): Promise<void> {
  const prepareResult = await instance.prepare({
    sessionId,
    userId,
    kiloSessionId,
    prompt: 'test prompt',
    mode: 'code',
    model: 'test-model',
    kilocodeToken: 'token',
    gitUrl: 'https://example.com/repo.git',
    gitToken: 'git-token',
    callbackTarget: { url: 'https://example.com/callback' },
  });
  expect(prepareResult.success).toBe(true);
}

describe('Callback notification with latest assistant message', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    expect(ids).toHaveLength(0);
  });

  it('includes lastAssistantMessageText on completed callbacks', async () => {
    const userId = 'user_cb_1';
    const sessionId = 'agent_cb_1';
    const executionId = 'exec_cb_completed' as ExecutionId;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const queue = createCapturedQueue();

    await runInDurableObject(stub, async (instance: CloudAgentSession, state) => {
      injectCallbackQueue(instance, queue);

      await prepareSessionWithCallback(instance, sessionId, userId);
      await seedAssistantMessage(state, sessionId, {
        messageId: 'msg_00000000000000000000000010',
        parts: [
          { id: 'part_00000000000000000000000001', type: 'text', text: 'Hello ' },
          { id: 'part_00000000000000000000000002', type: 'text', text: 'world' },
        ],
      });

      const addResult = await instance.addExecution({
        executionId,
        mode: 'followup',
        streamingMode: 'websocket',
      });
      expect(addResult.ok).toBe(true);

      await instance.updateExecutionStatus({ executionId, status: 'running' });
      await instance.updateExecutionStatus({ executionId, status: 'completed' });
    });

    expect(queue.captured).toHaveLength(1);
    const [job] = queue.captured;
    expect(job.payload.status).toBe('completed');
    expect(job.payload.lastAssistantMessageText).toBe('Hello world');
    expect(job.target.url).toBe('https://example.com/callback');
  });

  it('omits lastAssistantMessageText on failed callbacks', async () => {
    const userId = 'user_cb_2';
    const sessionId = 'agent_cb_2';
    const executionId = 'exec_cb_failed' as ExecutionId;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const queue = createCapturedQueue();

    await runInDurableObject(stub, async (instance: CloudAgentSession, state) => {
      injectCallbackQueue(instance, queue);

      await prepareSessionWithCallback(instance, sessionId, userId);
      await seedAssistantMessage(state, sessionId, {
        messageId: 'msg_00000000000000000000000011',
        parts: [{ id: 'part_00000000000000000000000001', type: 'text', text: 'Partial answer' }],
      });

      await instance.addExecution({
        executionId,
        mode: 'followup',
        streamingMode: 'websocket',
      });
      await instance.updateExecutionStatus({ executionId, status: 'running' });
      await instance.updateExecutionStatus({
        executionId,
        status: 'failed',
        error: 'sandbox crashed',
      });
    });

    expect(queue.captured).toHaveLength(1);
    const [job] = queue.captured;
    expect(job.payload.status).toBe('failed');
    expect(job.payload.errorMessage).toBe('sandbox crashed');
    expect(job.payload.lastAssistantMessageText).toBeUndefined();
  });

  it('omits lastAssistantMessageText on interrupted callbacks', async () => {
    const userId = 'user_cb_3';
    const sessionId = 'agent_cb_3';
    const executionId = 'exec_cb_interrupted' as ExecutionId;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const queue = createCapturedQueue();

    await runInDurableObject(stub, async (instance: CloudAgentSession, state) => {
      injectCallbackQueue(instance, queue);

      await prepareSessionWithCallback(instance, sessionId, userId);
      await seedAssistantMessage(state, sessionId, {
        messageId: 'msg_00000000000000000000000012',
        parts: [{ id: 'part_00000000000000000000000001', type: 'text', text: 'In progress' }],
      });

      await instance.addExecution({
        executionId,
        mode: 'followup',
        streamingMode: 'websocket',
      });
      await instance.updateExecutionStatus({ executionId, status: 'running' });
      await instance.updateExecutionStatus({ executionId, status: 'interrupted' });
    });

    expect(queue.captured).toHaveLength(1);
    const [job] = queue.captured;
    expect(job.payload.status).toBe('interrupted');
    expect(job.payload.lastAssistantMessageText).toBeUndefined();
  });

  it('omits lastAssistantMessageText when latest message has only non-text parts', async () => {
    const userId = 'user_cb_4';
    const sessionId = 'agent_cb_4';
    const executionId = 'exec_cb_toolonly' as ExecutionId;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const queue = createCapturedQueue();

    await runInDurableObject(stub, async (instance: CloudAgentSession, state) => {
      injectCallbackQueue(instance, queue);

      await prepareSessionWithCallback(instance, sessionId, userId);
      await seedAssistantMessage(state, sessionId, {
        messageId: 'msg_00000000000000000000000020',
        parts: [
          {
            id: 'part_00000000000000000000000001',
            type: 'tool',
            tool: 'read',
            state: { status: 'completed', output: 'file contents' },
          },
          {
            id: 'part_00000000000000000000000002',
            type: 'reasoning',
            text: 'thinking...',
          },
          {
            id: 'part_00000000000000000000000003',
            type: 'text',
            text: '   ',
          },
        ],
      });

      await instance.addExecution({
        executionId,
        mode: 'followup',
        streamingMode: 'websocket',
      });
      await instance.updateExecutionStatus({ executionId, status: 'running' });
      await instance.updateExecutionStatus({ executionId, status: 'completed' });
    });

    expect(queue.captured).toHaveLength(1);
    const [job] = queue.captured;
    expect(job.payload.status).toBe('completed');
    expect(job.payload.lastAssistantMessageText).toBeUndefined();
  });
});
