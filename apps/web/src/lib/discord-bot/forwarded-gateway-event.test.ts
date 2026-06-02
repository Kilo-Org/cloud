import { parseForwardedGatewayMessageEvent } from './forwarded-gateway-event';

const validEvent = {
  type: 'GATEWAY_MESSAGE_CREATE',
  timestamp: 1,
  botUserId: '111111111111111111',
  data: {
    id: '222222222222222222',
    content: '<@111111111111111111> hello',
    channel_id: '333333333333333333',
    guild_id: '444444444444444444',
    author: { id: '555555555555555555', username: 'alice', bot: false },
    mentions: [{ id: '111111111111111111' }],
    message_reference: { message_id: '666666666666666666' },
  },
};

describe('parseForwardedGatewayMessageEvent', () => {
  it('accepts valid forwarded Discord message events', () => {
    expect(parseForwardedGatewayMessageEvent(validEvent)).toEqual(validEvent);
  });

  it.each([
    ['message ID', { data: { id: '../../users/@me' } }],
    ['channel ID', { data: { channel_id: '333/../../users/@me' } }],
    ['guild ID', { data: { guild_id: 'guild?x=1' } }],
    ['author ID', { data: { author: { id: 'author#frag' } } }],
    ['mention ID', { data: { mentions: [{ id: 'mention/1' }] } }],
    ['message reference ID', { data: { message_reference: { message_id: 'ref/1' } } }],
  ])('rejects malformed %s', (_name, override) => {
    expect(parseForwardedGatewayMessageEvent(mergeEvent(validEvent, override))).toBeNull();
  });

  it('rejects invalid JSON shapes', () => {
    expect(parseForwardedGatewayMessageEvent(null)).toBeNull();
    expect(parseForwardedGatewayMessageEvent({ type: 'GATEWAY_MESSAGE_UPDATE' })).toBeNull();
  });
});

function mergeEvent(base: typeof validEvent, override: Record<string, unknown>) {
  return {
    ...base,
    ...override,
    data: {
      ...base.data,
      ...(typeof override.data === 'object' && override.data !== null ? override.data : {}),
      author: {
        ...base.data.author,
        ...getNestedRecord(override, 'data', 'author'),
      },
    },
  };
}

function getNestedRecord(
  value: Record<string, unknown>,
  firstKey: string,
  secondKey: string
): Record<string, unknown> {
  const firstValue = value[firstKey];
  if (!isTestRecord(firstValue)) {
    return {};
  }

  const secondValue = firstValue[secondKey];
  if (!isTestRecord(secondValue)) {
    return {};
  }

  return secondValue;
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
