import { buildDiscordApiUrl, isDiscordSnowflake, parseDiscordSnowflake } from './discord-id';

describe('discord-id', () => {
  it('accepts numeric snowflake values', () => {
    expect(isDiscordSnowflake('123456789012345678')).toBe(true);
    expect(parseDiscordSnowflake('123456789012345678', 'user ID')).toBe('123456789012345678');
  });

  it.each([
    '',
    ' ',
    'abc',
    '123/456',
    '123?limit=1',
    '123#frag',
    '%2f',
    '..',
    '1',
    '1234',
    '1234567890123456',
    '1'.repeat(21),
  ])('rejects malformed snowflake value %p', value => {
    expect(isDiscordSnowflake(value)).toBe(false);
    expect(() => parseDiscordSnowflake(value, 'user ID')).toThrow('Invalid Discord user ID');
  });

  it('builds fixed-origin Discord API URLs with encoded path segments', () => {
    expect(buildDiscordApiUrl(['channels', '123', 'messages'], { limit: 12 })).toBe(
      'https://discord.com/api/v10/channels/123/messages?limit=12'
    );
    expect(buildDiscordApiUrl(['reactions', '✅', '@me'])).toBe(
      'https://discord.com/api/v10/reactions/%E2%9C%85/%40me'
    );
  });
});
