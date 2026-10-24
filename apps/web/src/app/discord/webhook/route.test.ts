import { after, NextRequest } from 'next/server';
import { processDiscordBotMessage } from '@/lib/discord-bot';
import {
  addDiscordReaction,
  postDiscordMessage,
  removeDiscordReaction,
} from '@/lib/integrations/discord-service';
import { verifyDiscordRequest } from '@/lib/discord/verify-request';
import type { ForwardedGatewayEvent } from '@/lib/discord-bot/forwarded-gateway-event';
import { POST } from './route';

const mockRedisSet = jest.fn<Promise<'OK' | null>, [string, string, { nx: boolean; ex: number }]>();

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  DISCORD_BOT_TOKEN: 'test-bot-token',
  DISCORD_PUBLIC_KEY: 'test-public-key',
}));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    set: (key: string, value: string, options: { nx: boolean; ex: number }) =>
      mockRedisSet(key, value, options),
  },
}));
jest.mock('@/lib/discord-bot', () => ({ processDiscordBotMessage: jest.fn() }));
jest.mock('@/lib/integrations/discord-service', () => ({
  addDiscordReaction: jest.fn(),
  postDiscordMessage: jest.fn(),
  removeDiscordReaction: jest.fn(),
}));
jest.mock('@/lib/slack-bot/dev-user-info', () => ({ getDevUserSuffix: () => '' }));
jest.mock('@/lib/discord/verify-request', () => ({ verifyDiscordRequest: jest.fn() }));

const BOT_ID = '111111111111111111';
const MESSAGE_ID = '222222222222222222';
const CHANNEL_ID = '333333333333333333';
const GUILD_ID = '444444444444444444';
const AUTHOR_ID = '555555555555555555';

function makeEvent(
  data: Partial<ForwardedGatewayEvent['data']> = {},
  botUserId: string | null = BOT_ID
): ForwardedGatewayEvent {
  return {
    type: 'GATEWAY_MESSAGE_CREATE',
    timestamp: 1,
    botUserId,
    data: {
      id: MESSAGE_ID,
      content: `<@${BOT_ID}> hello`,
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      author: { id: AUTHOR_ID, username: 'test-user', bot: false },
      mentions: [{ id: BOT_ID }],
      ...data,
    },
  };
}

function deliver(event: unknown, token = 'test-bot-token') {
  return POST(
    new NextRequest('http://localhost/discord/webhook', {
      method: 'POST',
      headers: { 'x-discord-gateway-token': token },
      body: JSON.stringify(event),
    })
  );
}

function expectNoEffects() {
  expect(processDiscordBotMessage).not.toHaveBeenCalled();
  expect(addDiscordReaction).not.toHaveBeenCalled();
  expect(removeDiscordReaction).not.toHaveBeenCalled();
  expect(postDiscordMessage).not.toHaveBeenCalled();
}

function expectCompletedMessages(messageIds: string[]) {
  expect(processDiscordBotMessage).toHaveBeenCalledTimes(messageIds.length);
  expect(postDiscordMessage).toHaveBeenCalledTimes(messageIds.length);
  expect(addDiscordReaction).toHaveBeenCalledTimes(messageIds.length * 2);
  expect(removeDiscordReaction).toHaveBeenCalledTimes(messageIds.length);
  for (const messageId of messageIds) {
    expect(processDiscordBotMessage).toHaveBeenCalledWith('hello', GUILD_ID, {
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      userId: AUTHOR_ID,
      messageId,
    });
    expect(postDiscordMessage).toHaveBeenCalledWith(CHANNEL_ID, 'Test reply', {
      messageReference: { message_id: messageId },
    });
    expect(addDiscordReaction).toHaveBeenCalledWith(CHANNEL_ID, messageId, '\u23f3');
    expect(addDiscordReaction).toHaveBeenCalledWith(CHANNEL_ID, messageId, '\u2705');
    expect(removeDiscordReaction).toHaveBeenCalledWith(CHANNEL_ID, messageId, '\u23f3');
  }
}

describe('Discord forwarded message admission', () => {
  const acceptedUntil = new Map<string, number>();
  const afterCallbacks: Array<() => unknown> = [];
  let nowMs = 0;

  async function finishBackgroundWork() {
    await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    acceptedUntil.clear();
    afterCallbacks.length = 0;
    nowMs = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(after).mockImplementation(task => {
      afterCallbacks.push(typeof task === 'function' ? task : () => task);
    });
    mockRedisSet.mockReset();
    mockRedisSet.mockImplementation(async (key, _value, options) => {
      await Promise.resolve();
      const expiresAt = acceptedUntil.get(key);
      if (options.nx && expiresAt !== undefined && expiresAt > nowMs) {
        return null;
      }
      acceptedUntil.set(key, nowMs + options.ex * 1000);
      return 'OK';
    });
    jest.mocked(processDiscordBotMessage).mockReset();
    jest.mocked(processDiscordBotMessage).mockResolvedValue({
      response: 'Test reply',
      modelUsed: 'test-model',
      toolCallsMade: [],
      installation: null,
    });
    jest.mocked(addDiscordReaction).mockResolvedValue({ ok: true });
    jest.mocked(removeDiscordReaction).mockResolvedValue({ ok: true });
    jest.mocked(postDiscordMessage).mockResolvedValue({ ok: true, messageId: 'reply' });
    jest.mocked(verifyDiscordRequest).mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('processes and replies once for repeated accepted deliveries', async () => {
    const event = makeEvent();
    expect((await deliver(event)).status).toBe(200);
    expect(afterCallbacks).toHaveLength(1);
    expectNoEffects();
    await finishBackgroundWork();

    expect((await deliver(event)).status).toBe(200);
    await finishBackgroundWork();

    expect(after).toHaveBeenCalledTimes(1);
    expectCompletedMessages([MESSAGE_ID]);
    expect(mockRedisSet).toHaveBeenCalledWith(
      `discord:gateway-message:${BOT_ID}:${MESSAGE_ID}`,
      '1',
      { nx: true, ex: 900 }
    );
    expect(verifyDiscordRequest).not.toHaveBeenCalled();
  });

  it('processes concurrent deliveries of one message only once', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => deliver(makeEvent())));
    expect(responses.map(response => response.status)).toEqual(Array(8).fill(200));
    expect(afterCallbacks).toHaveLength(1);
    expectNoEffects();

    await finishBackgroundWork();

    expectCompletedMessages([MESSAGE_ID]);
  });

  it('processes distinct message ids independently', async () => {
    const secondId = '666666666666666666';
    const responses = await Promise.all([
      deliver(makeEvent()),
      deliver(makeEvent({ id: secondId })),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(afterCallbacks).toHaveLength(2);

    await finishBackgroundWork();

    expectCompletedMessages([MESSAGE_ID, secondId]);
  });

  it('scopes accepted messages by bot identity', async () => {
    const secondBotId = '777777777777777777';
    const responses = await Promise.all([
      deliver(makeEvent()),
      deliver(
        makeEvent(
          { content: `<@${secondBotId}> hello`, mentions: [{ id: secondBotId }] },
          secondBotId
        )
      ),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);

    await finishBackgroundWork();

    expectCompletedMessages([MESSAGE_ID, MESSAGE_ID]);
    expect(acceptedUntil.size).toBe(2);
  });

  it('accepts another delivery only after the 900-second window expires', async () => {
    expect((await deliver(makeEvent())).status).toBe(200);
    await finishBackgroundWork();

    nowMs = 899_999;
    expect((await deliver(makeEvent())).status).toBe(200);
    await finishBackgroundWork();
    expectCompletedMessages([MESSAGE_ID]);

    nowMs = 900_000;
    expect((await deliver(makeEvent())).status).toBe(200);
    await finishBackgroundWork();
    expectCompletedMessages([MESSAGE_ID, MESSAGE_ID]);
  });

  it('returns unavailable without scheduling work when admission fails', async () => {
    mockRedisSet.mockRejectedValueOnce(new Error('Store detail must remain private'));

    const response = await deliver(makeEvent());
    await finishBackgroundWork();

    expect(response.status).toBe(503);
    expect(after).not.toHaveBeenCalled();
    expectNoEffects();
    expect(console.error).toHaveBeenCalledWith(
      '[DiscordBot:Webhook] Message admission unavailable'
    );
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('retains acceptance when background processing fails', async () => {
    jest
      .mocked(processDiscordBotMessage)
      .mockRejectedValueOnce(new Error('Processing unavailable'));
    expect((await deliver(makeEvent())).status).toBe(200);

    await expect(finishBackgroundWork()).rejects.toThrow('Processing unavailable');
    expect((await deliver(makeEvent())).status).toBe(200);
    await finishBackgroundWork();

    expect(after).toHaveBeenCalledTimes(1);
    expect(processDiscordBotMessage).toHaveBeenCalledTimes(1);
    expect(addDiscordReaction).toHaveBeenCalledTimes(1);
    expect(addDiscordReaction).toHaveBeenCalledWith(CHANNEL_ID, MESSAGE_ID, '\u23f3');
    expect(removeDiscordReaction).not.toHaveBeenCalled();
    expect(postDiscordMessage).not.toHaveBeenCalled();
    expect(acceptedUntil.size).toBe(1);
  });

  it.each<[string, ForwardedGatewayEvent]>([
    ['bot author', makeEvent({ author: { id: AUTHOR_ID, username: 'test-bot', bot: true } })],
    ['missing bot identity', makeEvent({}, null)],
    ['absent mentions', makeEvent({ mentions: undefined })],
    ['another mention', makeEvent({ mentions: [{ id: '888888888888888888' }] })],
    ['empty remaining text', makeEvent({ content: ` <@${BOT_ID}>  ` })],
    ['nickname mention only', makeEvent({ content: `<@!${BOT_ID}>` })],
  ])('ignores %s without admission or background work', async (_name, event) => {
    expect((await deliver(event)).status).toBe(200);
    await finishBackgroundWork();

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it.each(['incorrect-token', 'x'.repeat('test-bot-token'.length)])(
    'rejects an incorrect forwarded token before admission',
    async token => {
      expect((await deliver(makeEvent(), token)).status).toBe(401);
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
      expect(verifyDiscordRequest).not.toHaveBeenCalled();
      expectNoEffects();
    }
  );

  it.each<[string, unknown]>([
    ['missing guild', makeEvent({ guild_id: '' })],
    ['malformed message id', makeEvent({ id: 'invalid-id' })],
    ['invalid shape', { type: 'GATEWAY_MESSAGE_CREATE' }],
  ])('rejects %s before admission', async (_name, event) => {
    expect((await deliver(event)).status).toBe(400);
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('rejects malformed forwarded JSON before admission', async () => {
    const response = await POST(
      new NextRequest('http://localhost/discord/webhook', {
        method: 'POST',
        headers: { 'x-discord-gateway-token': 'test-bot-token' },
        body: '{',
      })
    );

    expect(response.status).toBe(400);
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('uses signature verification when a forwarded token is absent', async () => {
    const body = JSON.stringify({ type: 1 });
    const response = await POST(
      new NextRequest('http://localhost/discord/webhook', { method: 'POST', body })
    );

    expect(response.status).toBe(401);
    expect(verifyDiscordRequest).toHaveBeenCalledWith(body, null, null, 'test-public-key');
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('responds to a verified interaction without message admission', async () => {
    jest.mocked(verifyDiscordRequest).mockResolvedValueOnce(true);
    const body = JSON.stringify({ type: 1 });
    const response = await POST(
      new NextRequest('http://localhost/discord/webhook', {
        method: 'POST',
        headers: { 'x-signature-ed25519': 'test-signature', 'x-signature-timestamp': '1' },
        body,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
    expect(verifyDiscordRequest).toHaveBeenCalledWith(
      body,
      'test-signature',
      '1',
      'test-public-key'
    );
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expectNoEffects();
  });
});
