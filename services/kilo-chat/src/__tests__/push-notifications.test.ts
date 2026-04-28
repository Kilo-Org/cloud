/**
 * Tests for the sendPushForConversation call site in the message.created path.
 *
 * The NOTIFICATIONS stub (defined in vitest.config.mts) records every
 * sendPushForConversation call in module scope. Tests reach the recording via
 * RPC helpers on the stub (__recordedCalls, __clearCalls, __setShouldFail).
 */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { makeApp } from './helpers';

type RecordingNotifications = typeof env.NOTIFICATIONS & {
  __recordedCalls(): Promise<Array<Record<string, unknown>>>;
  __clearCalls(): Promise<void>;
  __setShouldFail(val: boolean): Promise<void>;
};
const recordingNotifications = env.NOTIFICATIONS as RecordingNotifications;

async function waitForNotificationCalls(
  predicate: (calls: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 2000
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const calls = await recordingNotifications.__recordedCalls();
    if (predicate(calls)) return calls;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for sendPushForConversation calls; last: ${JSON.stringify(calls)}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function createConversation(suffix: string) {
  const userId = `user-push-${suffix}`;
  const sandboxId = `sandbox-push-${suffix}`;
  const botId = `bot:kiloclaw:${sandboxId}`;

  const userApp = makeApp(userId, 'user');
  const botApp = makeApp(botId, 'bot');

  const res = await userApp.request(
    '/v1/conversations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId, title: `Push Test ${suffix}` }),
    },
    env
  );
  expect(res.status).toBe(201);
  const { conversationId } = await res.json<{ conversationId: string }>();
  return { conversationId, userId, botId, sandboxId, userApp, botApp };
}

describe('push notifications on message.created', () => {
  beforeEach(async () => {
    await recordingNotifications.__clearCalls();
  });

  it('bot sends a message → sendPushForConversation called once with human recipients', async () => {
    const { conversationId, userId, botId, sandboxId, botApp } =
      await createConversation('bot-sends');

    const res = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Hello from bot' }],
        }),
      },
      env
    );
    expect(res.status).toBe(201);

    const calls = await waitForNotificationCalls(cs => cs.length >= 1);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.conversationId).toBe(conversationId);
    expect(call.sandboxId).toBe(sandboxId);
    expect(call.senderUserId).toBeNull();
    expect(Array.isArray(call.recipientUserIds)).toBe(true);
    expect(call.recipientUserIds).toContain(userId);
    expect((call.recipientUserIds as string[]).includes(botId)).toBe(false);
    expect(typeof call.messageId).toBe('string');
    expect(typeof call.title).toBe('string');
    expect(typeof call.bodyPreview).toBe('string');
    expect(call.bodyPreview).toBe('Hello from bot');
  });

  it('human sends in solo human+bot conversation → no push (recipient list empty)', async () => {
    const { conversationId, userApp } = await createConversation('human-sends-solo');

    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Hello from human' }],
        }),
      },
      env
    );
    expect(res.status).toBe(201);

    // Give any async work a moment to settle, then assert no push was sent
    await new Promise(resolve => setTimeout(resolve, 200));
    const calls = await recordingNotifications.__recordedCalls();
    // Human is the only human member; after filtering out the sender there are
    // no recipients, so sendPushForConversation must NOT be called.
    expect(calls).toHaveLength(0);
  });

  it('NOTIFICATIONS failure does not cause message-send to fail', async () => {
    await recordingNotifications.__setShouldFail(true);

    const { conversationId, botApp } = await createConversation('notify-fail');

    const res = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Bot message despite notification failure' }],
        }),
      },
      env
    );

    // The HTTP response must still be 201 even though NOTIFICATIONS will throw
    expect(res.status).toBe(201);
    const body = await res.json<{ messageId: string }>();
    expect(body.messageId).toBeTruthy();
  });
});
