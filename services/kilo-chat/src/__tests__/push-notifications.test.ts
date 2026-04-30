import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';
import { makeApp } from './helpers';

// fetchSandboxLabel hits Hyperdrive/pg. Mock it so the push call site doesn't
// need a real DB. Individual tests can override per-test as needed.
vi.mock('../services/sandbox-lookup', () => ({
  fetchSandboxLabel: vi.fn(async () => 'My Sandbox'),
}));

const sampleContent = [{ type: 'text', text: 'hello there' }];
const messageCreatedContext = (sandboxId: string, conversationId: string) =>
  `/kiloclaw/${sandboxId}/${conversationId}`;
const presenceContext = (sandboxId: string, conversationId: string) =>
  `/presence${messageCreatedContext(sandboxId, conversationId)}`;

async function waitForCalls(spy: { mock: { calls: unknown[][] } }, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spy.mock.calls.length > 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
}

function getMembershipDO(userId: string) {
  return env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId));
}

async function createConversation(userSuffix: string) {
  const userId = `user-${userSuffix}`;
  const sandboxId = `sandbox-${userSuffix}`;
  const botId = `bot:kiloclaw:${sandboxId}`;
  const userApp = makeApp(userId, 'user');
  const botApp = makeApp(botId, 'bot');

  const createRes = await userApp.request(
    '/v1/conversations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId, title: `Chat ${userSuffix}` }),
    },
    env
  );
  expect(createRes.status).toBe(201);
  const { conversationId } = await createRes.json<{ conversationId: string }>();
  return { conversationId, userId, botId, sandboxId, userApp, botApp };
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

  it('does not mark a recipient read when only the hidden conversation subscription receives the event', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFICATIONS, 'sendPushForConversation')
      .mockResolvedValue({ perRecipient: [] });
    const pushEventSpy = vi.spyOn(env.EVENT_SERVICE, 'pushEvent').mockResolvedValue(true);
    vi.spyOn(
      env.EVENT_SERVICE as typeof env.EVENT_SERVICE & {
        isUserInContext(userId: string, context: string): Promise<boolean>;
      },
      'isUserInContext'
    ).mockResolvedValue(false);

    const { conversationId, userId, botApp, sandboxId } =
      await createConversation('presence-hidden');
    const sendRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    expect(sendRes.status).toBe(201);

    const conversations = await getMembershipDO(userId).listConversations({ sandboxId });
    const row = conversations.conversations.find(c => c.conversationId === conversationId);
    expect(row?.lastActivityAt).not.toBeNull();
    expect(row?.lastReadAt).toBeNull();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ recipientUserIds: [userId] }));
    expect(pushEventSpy).not.toHaveBeenCalledWith(
      userId,
      `/kiloclaw/${sandboxId}`,
      'conversation.read',
      expect.anything()
    );
  });

  it('marks a recipient read when their conversation presence is active', async () => {
    vi.spyOn(env.NOTIFICATIONS, 'sendPushForConversation').mockResolvedValue({ perRecipient: [] });
    vi.spyOn(env.EVENT_SERVICE, 'pushEvent').mockResolvedValue(true);
    const presenceSpy = vi
      .spyOn(
        env.EVENT_SERVICE as typeof env.EVENT_SERVICE & {
          isUserInContext(userId: string, context: string): Promise<boolean>;
        },
        'isUserInContext'
      )
      .mockResolvedValue(true);

    const { conversationId, userId, botApp, sandboxId } =
      await createConversation('presence-active');
    const sendRes = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    expect(sendRes.status).toBe(201);

    const conversations = await getMembershipDO(userId).listConversations({ sandboxId });
    const row = conversations.conversations.find(c => c.conversationId === conversationId);
    expect(row?.lastActivityAt).not.toBeNull();
    expect(row?.lastReadAt).toBe(row?.lastActivityAt);
    expect(presenceSpy).toHaveBeenCalledWith(userId, presenceContext(sandboxId, conversationId));
  });
});
