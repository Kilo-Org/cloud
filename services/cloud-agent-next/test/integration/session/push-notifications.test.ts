import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import { createEventQueries } from '../../../src/session/queries/events.js';
import {
  getSessionMessageState,
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import { groupedRegisterSessionInput, registerReadySession } from '../../helpers/session-setup.js';

const KILO_SESSION_ID = 'ses_push_notification';
const COMPLETED_MESSAGE_ID = 'msg_018f1e2d3c4bPushCompleteAB';
const FAILED_MESSAGE_ID = 'msg_018f1e2d3c4bPushFailedABCD';
const INTERRUPTED_MESSAGE_ID = 'msg_018f1e2d3c4bPushIntrptABCD';
const RETRY_MESSAGE_ID = 'msg_018f1e2d3c4bPushRetryABCDE';
const MISSING_KILO_SESSION_MESSAGE_ID = 'msg_018f1e2d3c4bPushNoSessionA';
const SUPPRESSED_MESSAGE_ID = 'msg_018f1e2d3c4bPushSuppressAB';

async function createSession(userId: string) {
  const sessionId = `agent_${crypto.randomUUID()}`;
  const id = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
  return { sessionId, stub: env.CLOUD_AGENT_SESSION.get(id) };
}

async function getNotificationJobs(): Promise<unknown> {
  const response = await SELF.fetch('http://test/test/notification-jobs');
  return response.json();
}

async function failNextNotificationDispatch(): Promise<void> {
  const response = await SELF.fetch('http://test/test/notification-jobs/fail-next', {
    method: 'POST',
  });
  expect(response.ok).toBe(true);
}

function acceptedMessageState(messageId: string): SessionMessageState {
  return {
    messageId,
    status: 'accepted',
    prompt: 'complete the task',
    createdAt: 1,
    acceptedAt: 2,
    wrapperRunId: 'wr_push',
  };
}

async function registerSession(
  instance: CloudAgentSession,
  sessionId: string,
  userId: string,
  createdOnPlatform = 'cloud-agent-web'
): Promise<void> {
  await registerReadySession(instance, {
    sessionId,
    userId,
    kiloSessionId: KILO_SESSION_ID,
    prompt: 'complete the task',
    mode: 'code',
    model: 'test-model',
    kilocodeToken: 'push-test-token',
    createdOnPlatform,
  });
}

async function seedAssistantText(
  state: DurableObjectState,
  sessionId: string,
  parentMessageId: string,
  text: string
): Promise<void> {
  const events = createEventQueries(drizzle(state.storage, { logger: false }), state.storage.sql);
  const assistantMessageId = 'msg_push_assistant_response_0001';
  const timestamp = Date.now();
  events.upsert({
    executionId: 'exc_push',
    sessionId,
    streamEventType: 'kilocode',
    payload: JSON.stringify({
      event: 'message.updated',
      properties: {
        info: {
          id: assistantMessageId,
          role: 'assistant',
          sessionID: KILO_SESSION_ID,
          parentID: parentMessageId,
          time: { completed: timestamp },
        },
      },
    }),
    timestamp,
    entityId: `message/${assistantMessageId}`,
  });
  events.upsert({
    executionId: 'exc_push',
    sessionId,
    streamEventType: 'kilocode',
    payload: JSON.stringify({
      event: 'message.part.updated',
      properties: {
        part: {
          id: 'part_push_response_0001',
          messageID: assistantMessageId,
          sessionID: KILO_SESSION_ID,
          type: 'text',
          text,
        },
      },
    }),
    timestamp: timestamp + 1,
    entityId: `part/${assistantMessageId}/part_push_response_0001`,
  });
}

describe('CloudAgentSession push notification producer', () => {
  beforeEach(async () => {
    const response = await SELF.fetch('http://test/test/notification-jobs', { method: 'DELETE' });
    expect(response.ok).toBe(true);
  });

  it('dispatches a completed message push with assistant text', async () => {
    const userId = 'user_push_completed';
    const { sessionId, stub } = await createSession(userId);

    await runInDurableObject(stub, async (instance, state) => {
      await registerSession(instance, sessionId, userId);
      await seedAssistantText(
        state,
        sessionId,
        COMPLETED_MESSAGE_ID,
        'Assistant finished the task.'
      );
      await putSessionMessageState(
        instance.ctx.storage,
        acceptedMessageState(COMPLETED_MESSAGE_ID)
      );
      await (instance as any).terminalizeSessionMessageOnce(COMPLETED_MESSAGE_ID, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
    });

    await expect
      .poll(() => getNotificationJobs())
      .toEqual([
        {
          userId,
          cliSessionId: KILO_SESSION_ID,
          executionId: COMPLETED_MESSAGE_ID,
          status: 'completed',
          body: 'Assistant finished the task.',
        },
      ]);
  });

  it('dispatches failed message pushes through terminal settlement', async () => {
    const userId = 'user_push_failed';
    const { sessionId, stub } = await createSession(userId);

    await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(instance.ctx.storage, acceptedMessageState(FAILED_MESSAGE_ID));
      await (instance as any).terminalizeSessionMessageOnce(FAILED_MESSAGE_ID, {
        kind: 'failed',
        reason: 'wrapper_failure',
        error: 'Provider unavailable',
        completionSource: 'wrapper_failure',
      });
    });

    await expect
      .poll(() => getNotificationJobs())
      .toEqual([
        {
          userId,
          cliSessionId: KILO_SESSION_ID,
          executionId: FAILED_MESSAGE_ID,
          status: 'failed',
          body: 'Failed: Provider unavailable',
        },
      ]);
  });

  it('dispatches interrupted message pushes through terminal settlement', async () => {
    const userId = 'user_push_interrupted';
    const { sessionId, stub } = await createSession(userId);

    await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(
        instance.ctx.storage,
        acceptedMessageState(INTERRUPTED_MESSAGE_ID)
      );
      await (instance as any).terminalizeSessionMessageOnce(INTERRUPTED_MESSAGE_ID, {
        kind: 'interrupted',
        error: 'User interrupted',
        completionSource: 'interrupt',
      });
    });

    await expect
      .poll(() => getNotificationJobs())
      .toEqual([
        {
          userId,
          cliSessionId: KILO_SESSION_ID,
          executionId: INTERRUPTED_MESSAGE_ID,
          status: 'interrupted',
          body: 'Interrupted: Task interrupted',
        },
      ]);
  });

  it('repairs a transient push dispatch failure through the alarm path', async () => {
    const userId = 'user_push_retry';
    const { sessionId, stub } = await createSession(userId);
    await failNextNotificationDispatch();

    await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(instance.ctx.storage, acceptedMessageState(RETRY_MESSAGE_ID));
      await (instance as any).terminalizeSessionMessageOnce(RETRY_MESSAGE_ID, {
        kind: 'failed',
        reason: 'wrapper_failure',
        error: 'Transient provider failure',
        completionSource: 'wrapper_failure',
      });

      const pending = await getSessionMessageState(instance.ctx.storage, RETRY_MESSAGE_ID);
      expect(pending?.terminalEffects?.push?.disposition).toBe('pending');

      await instance.alarm();

      const repaired = await getSessionMessageState(instance.ctx.storage, RETRY_MESSAGE_ID);
      expect(repaired?.terminalEffects?.push?.disposition).toBe('accounted');
    });

    await expect
      .poll(() => getNotificationJobs())
      .toEqual([
        {
          userId,
          cliSessionId: KILO_SESSION_ID,
          executionId: RETRY_MESSAGE_ID,
          status: 'failed',
          body: 'Failed: Transient provider failure',
        },
        {
          userId,
          cliSessionId: KILO_SESSION_ID,
          executionId: RETRY_MESSAGE_ID,
          status: 'failed',
          body: 'Failed: Transient provider failure',
        },
      ]);
  });

  it('does not dispatch pushes before a kilo session id is available', async () => {
    const userId = 'user_push_without_kilo_session';
    const { sessionId, stub } = await createSession(userId);

    await runInDurableObject(stub, async instance => {
      const registerResult = await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'complete the task',
          mode: 'code',
          model: 'test-model',
          kilocodeToken: 'push-test-token',
          createdOnPlatform: 'cloud-agent-web',
        })
      );
      expect(registerResult.success).toBe(true);
      await putSessionMessageState(
        instance.ctx.storage,
        acceptedMessageState(MISSING_KILO_SESSION_MESSAGE_ID)
      );
      await (instance as any).terminalizeSessionMessageOnce(MISSING_KILO_SESSION_MESSAGE_ID, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });

      const persisted = await getSessionMessageState(
        instance.ctx.storage,
        MISSING_KILO_SESSION_MESSAGE_ID
      );
      expect(persisted?.terminalEffects?.push?.disposition).toBe('not-required');
    });

    await expect.poll(() => getNotificationJobs()).toEqual([]);
  });

  it('suppresses message pushes while a stream client is connected', async () => {
    const userId = 'user_push_connected';
    const { sessionId, stub } = await createSession(userId);

    await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      const pair = new WebSocketPair();
      instance.ctx.acceptWebSocket(pair[1], ['stream']);
      await putSessionMessageState(
        instance.ctx.storage,
        acceptedMessageState(SUPPRESSED_MESSAGE_ID)
      );
      await (instance as any).terminalizeSessionMessageOnce(SUPPRESSED_MESSAGE_ID, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
    });

    await expect.poll(() => getNotificationJobs()).toEqual([]);
  });

  it('suppresses message pushes for non-web sessions', async () => {
    const userId = 'user_push_non_web';
    const { sessionId, stub } = await createSession(userId);

    await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId, 'code-review');
      await putSessionMessageState(
        instance.ctx.storage,
        acceptedMessageState(SUPPRESSED_MESSAGE_ID)
      );
      await (instance as any).terminalizeSessionMessageOnce(SUPPRESSED_MESSAGE_ID, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
    });

    await expect.poll(() => getNotificationJobs()).toEqual([]);
  });
});
