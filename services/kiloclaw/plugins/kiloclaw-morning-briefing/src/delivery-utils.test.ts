import { describe, expect, it } from 'vitest';
import { parseStoredDelivery, resolveDeliveryRoute } from './delivery-utils';

describe('delivery-utils', () => {
  it('parseStoredDelivery ignores malformed entries and keeps valid ones', () => {
    const parsed = parseStoredDelivery([
      null,
      123,
      { channel: 'telegram', status: 'sent', target: '-5055658641' },
      { channel: 'discord', status: 'unknown' },
      { channel: 'slack', status: 'failed', reason: 'send_failed', error: 'send failed' },
      { channel: 'email', status: 'sent' },
      { channel: 'telegram', status: 'skipped', reason: 'bogus_reason' },
    ]);

    expect(parsed).toEqual([
      {
        channel: 'telegram',
        status: 'sent',
        target: '-5055658641',
      },
      {
        channel: 'slack',
        status: 'failed',
        reason: 'send_failed',
        error: 'send failed',
      },
      {
        channel: 'telegram',
        status: 'skipped',
      },
    ]);
  });

  it('resolveDeliveryRoute infers single discord fallback channel target', () => {
    const resolution = resolveDeliveryRoute({
      channel: 'discord',
      channelsConfig: {
        discord: {
          enabled: true,
          guilds: {
            'guild-1': {
              channels: {
                '1234567890': { enabled: true },
              },
            },
          },
        },
      },
    });

    expect(resolution).toEqual({
      configured: true,
      route: {
        channel: 'discord',
        target: 'channel:1234567890',
      },
    });
  });

  it('resolveDeliveryRoute infers single slack fallback channel target', () => {
    const resolution = resolveDeliveryRoute({
      channel: 'slack',
      channelsConfig: {
        slack: {
          enabled: true,
          channels: {
            C123456: { enabled: true },
          },
        },
      },
    });

    expect(resolution).toEqual({
      configured: true,
      route: {
        channel: 'slack',
        target: 'channel:C123456',
      },
    });
  });

  it('resolveDeliveryRoute marks ambiguous fallback when multiple discord channels exist', () => {
    const resolution = resolveDeliveryRoute({
      channel: 'discord',
      channelsConfig: {
        discord: {
          enabled: true,
          guilds: {
            'guild-1': {
              channels: {
                '123': { enabled: true },
                '456': { enabled: true },
              },
            },
          },
        },
      },
    });

    expect(resolution).toEqual({
      configured: true,
      route: null,
      skipReason: 'ambiguous_target',
    });
  });
});
