import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import { createEventQueries } from '../../../src/session/queries/events.js';
import {
  createPendingSessionMessage,
  createPendingSessionMessageFromIntent,
  storePendingSessionMessage,
} from '../../../src/session/pending-messages.js';
import {
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import { registerReadySession } from '../../helpers/session-setup.js';

const kiloSessionId = 'ses_message_result';
const messageA = 'msg_0123456789abAAAAAAAAAAAAAA';
const messageB = 'msg_0123456789abBBBBBBBBBBBBBB';

async function seedAssistantMessageWithParent(
  state: DurableObjectState,
  sessionId: string,
  input: {
    messageId: string;
    parentId: string;
    text: string;
    timestamp: number;
    kiloSessionId?: string;
  }
): Promise<void> {
  const events = createEventQueries(drizzle(state.storage, { logger: false }), state.storage.sql);
  events.upsert({
    executionId: 'exc_message_result',
    sessionId,
    streamEventType: 'kilocode',
    payload: JSON.stringify({
      event: 'message.updated',
      properties: {
        info: {
          id: input.messageId,
          role: 'assistant',
          sessionID: input.kiloSessionId ?? kiloSessionId,
          parentID: input.parentId,
          time: { completed: input.timestamp },
        },
      },
    }),
    timestamp: input.timestamp,
    entityId: `message/${input.messageId}`,
  });
  events.upsert({
    executionId: 'exc_message_result',
    sessionId,
    streamEventType: 'kilocode',
    payload: JSON.stringify({
      event: 'message.part.updated',
      properties: {
        part: {
          id: `part_${input.messageId}`,
          messageID: input.messageId,
          sessionID: input.kiloSessionId ?? kiloSessionId,
          type: 'text',
          text: input.text,
        },
      },
    }),
    timestamp: input.timestamp + 1,
    entityId: `part/${input.messageId}/part_${input.messageId}`,
  });
}

async function registerSession(instance: CloudAgentSession, sessionId: string, userId: string) {
  await registerReadySession(instance, {
    sessionId,
    userId,
    kiloSessionId,
    prompt: 'initial prompt',
    mode: 'code',
    model: 'test-model',
    kilocodeToken: 'private-kilo-token',
  });
}

function lifecycleState(
  messageId: string,
  overrides: Partial<SessionMessageState> = {}
): SessionMessageState {
  return {
    messageId,
    status: 'queued',
    prompt: 'private prompt',
    createdAt: 1,
    queuedAt: 1,
    ...overrides,
  };
}

describe('CloudAgentSession.getMessageResult', () => {
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

  it('returns session-not-found when metadata is absent', async () => {
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName('user_message_result_missing:agent_message_result_missing')
    );

    await expect(stub.getMessageResult(messageA)).resolves.toEqual({ type: 'session-not-found' });
  });

  it('returns message-not-found when the exact message ID is absent', async () => {
    const userId = 'user_message_result_unknown';
    const sessionId = 'agent_message_result_unknown';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({ type: 'message-not-found' });
  });

  it('returns correlated assistant text for an exact completed turn', async () => {
    const userId = 'user_message_result_exact';
    const sessionId = 'agent_message_result_exact';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(
        instance.ctx.storage,
        lifecycleState(messageA, {
          status: 'completed',
          acceptedAt: 2,
          terminalAt: 3,
          assistantMessageId: 'assistant_exact',
          completionSource: 'assistant_message_event',
        })
      );
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'assistant_exact',
        parentId: messageA,
        text: 'Completed answer',
        timestamp: 10,
      });
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'assistant_duplicate',
        parentId: messageA,
        text: 'Wrong duplicate answer',
        timestamp: 20,
      });
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId: messageA,
        status: 'completed',
        createdAt: 1,
        queuedAt: 1,
        acceptedAt: 2,
        terminalAt: 3,
        completionSource: 'assistant_message_event',
        assistant: { messageId: 'assistant_exact', text: 'Completed answer' },
      },
    });
  });

  it('omits assistant text when a persisted assistant ID belongs to another turn', async () => {
    const userId = 'user_message_result_mismatched_parent';
    const sessionId = 'agent_message_result_mismatched_parent';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(
        instance.ctx.storage,
        lifecycleState(messageA, {
          status: 'completed',
          terminalAt: 3,
          assistantMessageId: 'assistant_wrong_parent',
        })
      );
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'assistant_wrong_parent',
        parentId: messageB,
        text: 'Wrong parent answer',
        timestamp: 10,
      });
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId: messageA,
        status: 'completed',
        createdAt: 1,
        queuedAt: 1,
        terminalAt: 3,
      },
    });
  });

  it('omits assistant text when a persisted assistant ID belongs to another Kilo session', async () => {
    const userId = 'user_message_result_mismatched_kilo_session';
    const sessionId = 'agent_message_result_mismatched_kilo_session';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(
        instance.ctx.storage,
        lifecycleState(messageA, {
          status: 'completed',
          terminalAt: 3,
          assistantMessageId: 'assistant_wrong_kilo_session',
        })
      );
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'assistant_wrong_kilo_session',
        parentId: messageA,
        text: 'Wrong Kilo session answer',
        timestamp: 10,
        kiloSessionId: 'ses_child',
      });
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId: messageA,
        status: 'completed',
        createdAt: 1,
        queuedAt: 1,
        terminalAt: 3,
      },
    });
  });

  it('returns a queued recovery result for pending-only compatibility rows', async () => {
    const userId = 'user_message_result_pending';
    const sessionId = 'agent_message_result_pending';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      await storePendingSessionMessage(
        instance.ctx.storage,
        createPendingSessionMessage({
          messageId: messageA,
          role: 'user',
          content: 'private pending prompt',
          createdAt: 5,
          lastFlushError: 'private pending failure',
        })
      );
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId: messageA,
        status: 'queued',
        createdAt: 5,
        queuedAt: 5,
      },
    });
  });

  it('fails closed when a corrupt lifecycle row has pending compatibility residue', async () => {
    const userId = 'user_message_result_corrupt';
    const sessionId = 'agent_message_result_corrupt';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      await storePendingSessionMessage(
        instance.ctx.storage,
        createPendingSessionMessage({
          messageId: messageA,
          role: 'user',
          content: 'private pending prompt',
          createdAt: 5,
        })
      );
      await instance.ctx.storage.put(`session_message:${messageA}`, {
        messageId: 'invalid',
        status: 'queued',
        prompt: 'corrupt lifecycle prompt',
        createdAt: 1,
      });
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({ type: 'state-invalid' });
  });

  it('fails closed when a lifecycle row embeds another valid message ID', async () => {
    const userId = 'user_message_result_mismatched_identity';
    const sessionId = 'agent_message_result_mismatched_identity';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      await instance.ctx.storage.put(`session_message:${messageA}`, lifecycleState(messageB));
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({ type: 'state-invalid' });
  });

  it('returns a safe exact result for current pending rows', async () => {
    const userId = 'user_message_result_current_pending';
    const sessionId = 'agent_message_result_current_pending';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const token = 'private-current-pending-token';

    const result = await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      const pending = createPendingSessionMessageFromIntent(
        {
          turn: { type: 'prompt', messageId: messageB, prompt: token },
          agent: { mode: 'code', model: 'test-model' },
        },
        6,
        {
          required: true,
          target: { url: 'https://example.com', headers: { Authorization: token } },
        }
      );
      await storePendingSessionMessage(instance.ctx.storage, { ...pending, lastFlushError: token });
      return instance.getMessageResult(messageB);
    });

    expect(result).toEqual({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId: messageB,
        status: 'queued',
        createdAt: 6,
        queuedAt: 6,
      },
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('does not expose assistant text for a queued turn', async () => {
    const userId = 'user_message_result_queued';
    const sessionId = 'agent_message_result_queued';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(instance.ctx.storage, lifecycleState(messageA));
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'assistant_stale',
        parentId: messageA,
        text: 'Stale answer',
        timestamp: 10,
      });
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId: messageA,
        status: 'queued',
        createdAt: 1,
        queuedAt: 1,
      },
    });
  });

  it('omits assistant text for completed rows without an assistant message ID', async () => {
    const userId = 'user_message_result_parent';
    const sessionId = 'agent_message_result_parent';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(
        instance.ctx.storage,
        lifecycleState(messageA, { status: 'completed', terminalAt: 3 })
      );
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'assistant_selected',
        parentId: messageA,
        text: 'Selected answer',
        timestamp: 10,
      });
      await seedAssistantMessageWithParent(state, sessionId, {
        messageId: 'assistant_latest',
        parentId: messageB,
        text: 'Wrong latest answer',
        timestamp: 20,
      });
      return instance.getMessageResult(messageA);
    });

    expect(result).toEqual({
      type: 'found',
      result: {
        cloudAgentSessionId: sessionId,
        messageId: messageA,
        status: 'completed',
        createdAt: 1,
        queuedAt: 1,
        terminalAt: 3,
      },
    });
  });

  it('never exposes sensitive persisted diagnostics', async () => {
    const userId = 'user_message_result_safe';
    const sessionId = 'agent_message_result_safe';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const token = 'private-token-like-text';

    const result = await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(
        instance.ctx.storage,
        lifecycleState(messageA, {
          status: 'failed',
          prompt: token,
          admissionSnapshot: {
            turn: { type: 'prompt', messageId: messageA, prompt: token },
            agent: { mode: 'code', model: 'test-model' },
          },
          error: token,
          failureReason: token,
          callbackTarget: { url: 'https://example.com', headers: { Authorization: token } },
          callbackLastError: token,
          terminalEffects: {
            event: 'pending',
            callback: { disposition: 'pending', allowWithoutObservedIdle: false },
          },
        })
      );
      return instance.getMessageResult(messageA);
    });

    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('returns allowlisted structured failure fields', async () => {
    const userId = 'user_message_result_failure';
    const sessionId = 'agent_message_result_failure';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerSession(instance, sessionId, userId);
      await putSessionMessageState(
        instance.ctx.storage,
        lifecycleState(messageA, {
          status: 'failed',
          terminalAt: 3,
          completionSource: 'wrapper_failure',
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
          attempts: 2,
        })
      );
      return instance.getMessageResult(messageA);
    });

    expect(result).toMatchObject({
      type: 'found',
      result: { failure: { stage: 'agent_activity', code: 'assistant_error', attempts: 2 } },
    });
  });
});
