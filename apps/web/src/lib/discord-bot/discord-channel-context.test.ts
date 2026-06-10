jest.mock('@/lib/config.server', () => ({
  DISCORD_BOT_TOKEN: 'bot-token',
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { getDiscordConversationContext } from './discord-channel-context';

describe('getDiscordConversationContext', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('does not fetch Discord API data when the channel ID is malformed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await getDiscordConversationContext({
      channelId: '../../users/@me',
      guildId: '111111111111111111',
      userId: '222222222222222222',
      messageId: '333333333333333333',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.channel).toBeNull();
    expect(result.recentMessages).toEqual([]);
    expect(result.errors).toEqual(['Invalid Discord channel ID']);
  });

  it('uses fixed-origin Discord API URLs for valid context fetches', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '111111111111111111', type: 0, name: 'general' }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: '222222222222222222',
              content: 'hello',
              timestamp: '2026-06-02T00:00:00.000Z',
              author: { id: '333333333333333333', username: 'alice' },
            },
          ]),
          { status: 200 }
        )
      );

    const result = await getDiscordConversationContext(
      {
        channelId: '111111111111111111',
        guildId: '444444444444444444',
        userId: '333333333333333333',
        messageId: '222222222222222222',
      },
      { channelMessages: 1 }
    );

    expect(result.errors).toEqual([]);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/v10/channels/111111111111111111',
      { headers: { Authorization: 'Bot bot-token' } }
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/v10/channels/111111111111111111/messages?limit=1',
      { headers: { Authorization: 'Bot bot-token' } }
    );
  });
});
