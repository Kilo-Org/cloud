jest.mock('@/lib/config.server', () => ({
  DISCORD_OAUTH_BOT_TOKEN: 'bot-token',
  DISCORD_SERVER_ID: '123456789012345678',
}));

import { checkDiscordGuildMembership } from './discord-guild-membership';

describe('checkDiscordGuildMembership', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects malformed Discord user IDs before fetching', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(checkDiscordGuildMembership('user/1')).rejects.toThrow('Invalid Discord user ID');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses fixed-origin Discord API URLs for valid user IDs', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await expect(checkDiscordGuildMembership('234567890123456789')).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://discord.com/api/v10/guilds/123456789012345678/members/234567890123456789',
      expect.objectContaining({ headers: { Authorization: 'Bot bot-token' } })
    );
  });
});
