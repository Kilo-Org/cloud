import type { ForwardedGatewayEvent } from './forwarded-gateway-event';
import { shouldProcessGatewayMessage } from './gateway-message';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  DISCORD_BOT_TOKEN: 'test-bot-token',
}));

const BOT_ID = '111111111111111111';
const event: ForwardedGatewayEvent = {
  type: 'GATEWAY_MESSAGE_CREATE',
  timestamp: 1,
  botUserId: BOT_ID,
  data: {
    id: '222222222222222222',
    content: `<@${BOT_ID}> hello`,
    channel_id: '333333333333333333',
    guild_id: '444444444444444444',
    author: { id: '555555555555555555', username: 'test-user', bot: false },
    mentions: [{ id: BOT_ID }],
  },
};

describe('shouldProcessGatewayMessage', () => {
  it.each<[string, ForwardedGatewayEvent['data']]>([
    ['ordinary mention', event.data],
    ['nickname mention', { ...event.data, content: `<@!${BOT_ID}> hello` }],
    ['mention metadata with remaining text', { ...event.data, content: 'hello' }],
    [
      'unspecified author bot flag',
      { ...event.data, author: { ...event.data.author, bot: undefined } },
    ],
  ])('accepts %s with remaining text', (_name, data) => {
    expect(shouldProcessGatewayMessage({ ...event, data })).toBe(true);
  });

  it.each<[string, ForwardedGatewayEvent['data']]>([
    ['bot author', { ...event.data, author: { ...event.data.author, bot: true } }],
    ['missing guild', { ...event.data, guild_id: '' }],
    ['absent mentions', { ...event.data, mentions: undefined }],
    ['empty mentions', { ...event.data, mentions: [] }],
    ['another mention', { ...event.data, mentions: [{ id: '666666666666666666' }] }],
    ['empty content', { ...event.data, content: '' }],
    ['whitespace content', { ...event.data, content: ' \n\t ' }],
    ['ordinary mention only', { ...event.data, content: `<@${BOT_ID}>` }],
    ['nickname mention only', { ...event.data, content: `<@!${BOT_ID}>` }],
    ['repeated mentions only', { ...event.data, content: ` <@${BOT_ID}> <@!${BOT_ID}> ` }],
  ])('ignores %s', (_name, data) => {
    expect(shouldProcessGatewayMessage({ ...event, data })).toBe(false);
  });

  it('ignores an event without bot identity', () => {
    expect(shouldProcessGatewayMessage({ ...event, botUserId: null })).toBe(false);
  });
});
