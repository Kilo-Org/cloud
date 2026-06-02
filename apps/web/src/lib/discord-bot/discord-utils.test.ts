jest.mock('@/lib/config.server', () => ({
  DISCORD_BOT_TOKEN: 'bot-token',
}));

import {
  buildDiscordMessageLink,
  replaceDiscordUserMentionsWithNames,
  stripDiscordBotMention,
} from './discord-utils';

describe('discord-utils', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('does not strip mentions when the bot ID is malformed', () => {
    expect(stripDiscordBotMention('<@bot/1> hello', 'bot/1')).toBe('<@bot/1> hello');
  });

  it('rejects malformed message link IDs', () => {
    expect(() => buildDiscordMessageLink('111111111111111111', '2/../3', '4')).toThrow(
      'Invalid Discord channel ID'
    );
  });

  it('does not fetch members when the guild ID is malformed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      replaceDiscordUserMentionsWithNames('<@123456789012345678>', 'guild/1')
    ).resolves.toBe('<@123456789012345678>');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches valid mention IDs through the fixed Discord API origin', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ nick: 'Alice' }), { status: 200 }));

    await expect(
      replaceDiscordUserMentionsWithNames('<@123456789012345678>', '234567890123456789')
    ).resolves.toBe('@Alice');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://discord.com/api/v10/guilds/234567890123456789/members/123456789012345678',
      { headers: { Authorization: 'Bot bot-token' } }
    );
  });
});
