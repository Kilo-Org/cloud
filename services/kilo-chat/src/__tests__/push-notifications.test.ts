import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';
import { makeApp } from './helpers';
import { logger } from '../util/logger';

// fetchSandboxLabel hits Hyperdrive/pg. Mock it so the push call site doesn't
// need a real DB. Individual tests can override per-test as needed.
vi.mock('../services/sandbox-lookup', () => ({
  fetchSandboxLabel: vi.fn(async () => 'My Sandbox'),
}));

const sampleContent = [{ type: 'text', text: 'hello there' }];

async function waitForCalls(spy: { mock: { calls: unknown[][] } }, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spy.mock.calls.length > 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
}

async function waitForAlarm(
  stub: DurableObjectStub<ConversationDO>,
  timeoutMs = 1000
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    if (alarm !== null) return alarm;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}

describe('kilo-chat publishes push on message.created', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT call sendPushForConversation when only the sender is a human member', async () => {
    // Single-human conversation: sender + bot. After excluding the sender,
    // recipientUserIds is empty, so the push fanout must be skipped.
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });

    const userId = 'user-push-skip-1';
    const sandboxId = 'sandbox-push-skip-1';
    const userApp = makeApp(userId, 'user');

    const createRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Push skip' }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const { conversationId } = await createRes.json<{ conversationId: string }>();

    const sendRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    expect(sendRes.status).toBe(201);

    // Give any waitUntil tasks a chance to fire then assert the push wasn't
    // called — there are no human recipients other than the sender.
    await new Promise(r => setTimeout(r, 50));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('calls sendPushForConversation with non-sender humans when conversation has multiple humans', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });

    const senderId = 'user-push-multi-sender';
    const otherId = 'user-push-multi-other';
    const sandboxId = 'sandbox-push-multi';
    const conversationId = '01KQD0T86VR3M1RPQCF4WBFX1W';
    const botId = `bot:kiloclaw:${sandboxId}`;

    // Seed a multi-human conversation directly via the ConversationDO so we
    // can exercise the push fanout's non-sender recipient path.
    const convStub: DurableObjectStub<ConversationDO> = env.CONVERSATION_DO.get(
      env.CONVERSATION_DO.idFromName(conversationId)
    );
    const initRes = await convStub.initialize({
      id: conversationId,
      title: 'Multi-human',
      createdBy: senderId,
      createdAt: Date.now(),
      members: [
        { id: senderId, kind: 'user' },
        { id: otherId, kind: 'user' },
        { id: botId, kind: 'bot' },
      ],
    });
    expect(initRes.ok).toBe(true);

    const senderApp = makeApp(senderId, 'user');
    const sendRes = await senderApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    expect(sendRes.status).toBe(201);
    const { messageId } = await sendRes.json<{ messageId: string }>();

    await waitForCalls(sendSpy);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0][0] as {
      conversationId: string;
      sandboxId: string;
      senderUserId: string | null;
      recipientUserIds: string[];
      title: string;
      bodyPreview: string;
      messageId: string;
    };
    expect(call.conversationId).toBe(conversationId);
    expect(call.sandboxId).toBe(sandboxId);
    expect(call.senderUserId).toBe(senderId);
    expect(call.recipientUserIds).toContain(otherId);
    expect(call.recipientUserIds).not.toContain(senderId);
    expect(call.bodyPreview).toContain('hello there');
    expect(call.title).toContain('My Sandbox');
    expect(call.messageId).toBe(messageId);
  });

  it('does not block the send when sendPushForConversation rejects', async () => {
    vi.spyOn(env.NOTIFICATIONS, 'sendPushForConversation').mockRejectedValue(
      new Error('downstream blew up')
    );

    const senderId = 'user-push-throw-sender';
    const otherId = 'user-push-throw-other';
    const sandboxId = 'sandbox-push-throw';
    const conversationId = '01KQD0T86WRTBR2NXX0VX3MY1M';
    const botId = `bot:kiloclaw:${sandboxId}`;

    const convStub: DurableObjectStub<ConversationDO> = env.CONVERSATION_DO.get(
      env.CONVERSATION_DO.idFromName(conversationId)
    );
    const initRes = await convStub.initialize({
      id: conversationId,
      title: 'Throw',
      createdBy: senderId,
      createdAt: Date.now(),
      members: [
        { id: senderId, kind: 'user' },
        { id: otherId, kind: 'user' },
        { id: botId, kind: 'bot' },
      ],
    });
    expect(initRes.ok).toBe(true);

    const senderApp = makeApp(senderId, 'user');
    // Even with the push throwing inside the post-commit fan-out, the send
    // must still succeed because the failure is swallowed by try/catch.
    const sendRes = await senderApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    expect(sendRes.status).toBe(201);
    const body = await sendRes.json<{ messageId: string }>();
    expect(body.messageId).toBeTruthy();
  });

  it('logs returned per-recipient push failures without blocking the send', async () => {
    vi.spyOn(env.NOTIFICATIONS, 'sendPushForConversation').mockResolvedValue({
      perRecipient: [{ userId: 'user-push-failed-other', outcome: 'failed' }],
    });
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const senderId = 'user-push-failed-sender';
    const otherId = 'user-push-failed-other';
    const sandboxId = 'sandbox-push-failed';
    const conversationId = '01KQD0T86WRTBR2NXX0VX3MY1N';
    const botId = `bot:kiloclaw:${sandboxId}`;

    const convStub: DurableObjectStub<ConversationDO> = env.CONVERSATION_DO.get(
      env.CONVERSATION_DO.idFromName(conversationId)
    );
    const initRes = await convStub.initialize({
      id: conversationId,
      title: 'Returned failure',
      createdBy: senderId,
      createdAt: Date.now(),
      members: [
        { id: senderId, kind: 'user' },
        { id: otherId, kind: 'user' },
        { id: botId, kind: 'bot' },
      ],
    });
    expect(initRes.ok).toBe(true);

    const senderApp = makeApp(senderId, 'user');
    const sendRes = await senderApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    expect(sendRes.status).toBe(201);
    const { messageId } = await sendRes.json<{ messageId: string }>();

    await waitForCalls(logSpy);
    expect(logSpy).toHaveBeenCalledWith('sendPushForConversation returned failed outcomes', {
      conversationId,
      sandboxId,
      messageId,
      trigger: 'message.created',
      failedRecipients: [{ userId: otherId, outcome: 'failed' }],
    });
  });

  it('notifies all human members when a bot message reaches the length threshold', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });

    const userId = 'user-bot-length';
    const sandboxId = 'sandbox-bot-length';
    const botId = `bot:kiloclaw:${sandboxId}`;
    const userApp = makeApp(userId, 'user');
    const botApp = makeApp(botId, 'bot');

    const createConversationRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Bot length' }),
      },
      env
    );
    expect(createConversationRes.status).toBe(201);
    const { conversationId } = await createConversationRes.json<{ conversationId: string }>();

    const createMessageRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: [{ type: 'text', text: 'short' }] }),
      },
      env
    );
    expect(createMessageRes.status).toBe(201);
    const { messageId } = await createMessageRes.json<{ messageId: string }>();
    expect(sendSpy).not.toHaveBeenCalled();

    const belowThresholdText = 'x'.repeat(120);
    const belowThresholdEditRes = await botApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: belowThresholdText }],
          timestamp: Date.now(),
        }),
      },
      env
    );
    expect(belowThresholdEditRes.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sendSpy).not.toHaveBeenCalled();

    const longText = 'x'.repeat(160);
    const editRes = await botApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: longText }],
          timestamp: Date.now() + 1,
        }),
      },
      env
    );
    expect(editRes.status).toBe(200);

    await waitForCalls(sendSpy);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      conversationId,
      sandboxId,
      senderUserId: null,
      recipientUserIds: [userId],
      bodyPreview: longText.slice(0, 200),
      messageId,
    });

    const secondEditRes = await botApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: `${longText} More streamed text.` }],
          timestamp: Date.now() + 2,
        }),
      },
      env
    );
    expect(secondEditRes.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('notifies the latest unnotified bot message when bot typing stops', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });

    const userId = 'user-bot-typing-stop';
    const sandboxId = 'sandbox-bot-typing-stop';
    const botId = `bot:kiloclaw:${sandboxId}`;
    const userApp = makeApp(userId, 'user');
    const botApp = makeApp(botId, 'bot');

    const createConversationRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Bot typing stop' }),
      },
      env
    );
    expect(createConversationRes.status).toBe(201);
    const { conversationId } = await createConversationRes.json<{ conversationId: string }>();

    const createMessageRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Short final answer.' }],
        }),
      },
      env
    );
    expect(createMessageRes.status).toBe(201);
    const { messageId } = await createMessageRes.json<{ messageId: string }>();
    expect(sendSpy).not.toHaveBeenCalled();

    const stopRes = await botApp.request(
      `/v1/conversations/${conversationId}/typing/stop`,
      { method: 'POST' },
      env
    );
    expect(stopRes.status).toBe(200);

    await waitForCalls(sendSpy);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      conversationId,
      sandboxId,
      senderUserId: null,
      recipientUserIds: [userId],
      bodyPreview: 'Short final answer.',
      messageId,
    });

    const duplicateStopRes = await botApp.request(
      `/v1/conversations/${conversationId}/typing/stop`,
      { method: 'POST' },
      env
    );
    expect(duplicateStopRes.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('does not notify a deleted bot message when bot typing stops', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });

    const userId = 'user-bot-typing-stop-deleted';
    const sandboxId = 'sandbox-bot-typing-stop-deleted';
    const botId = `bot:kiloclaw:${sandboxId}`;
    const userApp = makeApp(userId, 'user');
    const botApp = makeApp(botId, 'bot');

    const createConversationRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Bot typing stop deleted' }),
      },
      env
    );
    expect(createConversationRes.status).toBe(201);
    const { conversationId } = await createConversationRes.json<{ conversationId: string }>();

    const createMessageRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Short answer to delete.' }],
        }),
      },
      env
    );
    expect(createMessageRes.status).toBe(201);
    const { messageId } = await createMessageRes.json<{ messageId: string }>();

    const deleteQs = new URLSearchParams({ conversationId });
    const deleteRes = await botApp.request(
      `/v1/messages/${messageId}?${deleteQs.toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(deleteRes.status).toBe(200);

    const stopRes = await botApp.request(
      `/v1/conversations/${conversationId}/typing/stop`,
      { method: 'POST' },
      env
    );
    expect(stopRes.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('notifies an unnotified bot message when the timeout alarm fires', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });

    const userId = 'user-bot-timeout';
    const sandboxId = 'sandbox-bot-timeout';
    const botId = `bot:kiloclaw:${sandboxId}`;
    const userApp = makeApp(userId, 'user');
    const botApp = makeApp(botId, 'bot');

    const createConversationRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Bot timeout' }),
      },
      env
    );
    expect(createConversationRes.status).toBe(201);
    const { conversationId } = await createConversationRes.json<{ conversationId: string }>();

    const createMessageRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Still thinking.' }],
        }),
      },
      env
    );
    expect(createMessageRes.status).toBe(201);
    const { messageId } = await createMessageRes.json<{ messageId: string }>();
    expect(sendSpy).not.toHaveBeenCalled();

    const stub: DurableObjectStub<ConversationDO> = env.CONVERSATION_DO.get(
      env.CONVERSATION_DO.idFromName(conversationId)
    );
    const alarmAt = await waitForAlarm(stub);
    expect(alarmAt).not.toBeNull();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Number(alarmAt));
    try {
      await runInDurableObject(stub, async inst => {
        await (inst as unknown as { alarm: () => Promise<void> }).alarm();
      });
    } finally {
      nowSpy.mockRestore();
    }

    await waitForCalls(sendSpy);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      conversationId,
      sandboxId,
      senderUserId: null,
      recipientUserIds: [userId],
      bodyPreview: 'Still thinking.',
      messageId,
    });

    await runInDurableObject(stub, async inst => {
      await (inst as unknown as { alarm: () => Promise<void> }).alarm();
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('does not notify a deleted bot message when the timeout alarm fires', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });

    const userId = 'user-bot-timeout-deleted';
    const sandboxId = 'sandbox-bot-timeout-deleted';
    const botId = `bot:kiloclaw:${sandboxId}`;
    const userApp = makeApp(userId, 'user');
    const botApp = makeApp(botId, 'bot');

    const createConversationRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Bot timeout deleted' }),
      },
      env
    );
    expect(createConversationRes.status).toBe(201);
    const { conversationId } = await createConversationRes.json<{ conversationId: string }>();

    const createMessageRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Still thinking, then deleted.' }],
        }),
      },
      env
    );
    expect(createMessageRes.status).toBe(201);
    const { messageId } = await createMessageRes.json<{ messageId: string }>();

    const stub: DurableObjectStub<ConversationDO> = env.CONVERSATION_DO.get(
      env.CONVERSATION_DO.idFromName(conversationId)
    );
    const alarmAt = await waitForAlarm(stub);
    expect(alarmAt).not.toBeNull();

    const deleteQs = new URLSearchParams({ conversationId });
    const deleteRes = await botApp.request(
      `/v1/messages/${messageId}?${deleteQs.toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(deleteRes.status).toBe(200);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Number(alarmAt));
    try {
      await runInDurableObject(stub, async inst => {
        await (inst as unknown as { alarm: () => Promise<void> }).alarm();
      });
    } finally {
      nowSpy.mockRestore();
    }

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('reschedules the bot notification alarm for the next pending bot message', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });

    const userId = 'user-bot-timeout-reschedule';
    const sandboxId = 'sandbox-bot-timeout-reschedule';
    const botId = `bot:kiloclaw:${sandboxId}`;
    const userApp = makeApp(userId, 'user');
    const botApp = makeApp(botId, 'bot');

    const createConversationRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Bot timeout reschedule' }),
      },
      env
    );
    expect(createConversationRes.status).toBe(201);
    const { conversationId } = await createConversationRes.json<{ conversationId: string }>();

    const firstRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: [{ type: 'text', text: 'first' }] }),
      },
      env
    );
    expect(firstRes.status).toBe(201);

    await new Promise(resolve => setTimeout(resolve, 5));

    const secondRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: [{ type: 'text', text: 'second' }] }),
      },
      env
    );
    expect(secondRes.status).toBe(201);

    const stub: DurableObjectStub<ConversationDO> = env.CONVERSATION_DO.get(
      env.CONVERSATION_DO.idFromName(conversationId)
    );
    const firstAlarm = await waitForAlarm(stub);
    expect(firstAlarm).not.toBeNull();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Number(firstAlarm));
    try {
      await runInDurableObject(stub, async inst => {
        await (inst as unknown as { alarm: () => Promise<void> }).alarm();
      });
    } finally {
      nowSpy.mockRestore();
    }

    await waitForCalls(sendSpy);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const secondAlarm = await waitForAlarm(stub);
    expect(secondAlarm).not.toBeNull();
    expect(Number(secondAlarm)).toBeGreaterThan(Number(firstAlarm));
  });
});
