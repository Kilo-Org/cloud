import { describe, expect, it } from '@jest/globals';
import {
  USAGE_LIMIT_UNKNOWN_RESET_WINDOW_MS,
  isChatGptUsageLimitCurrent,
  readChatGptUsageLimit,
} from './usage-limit';

const NOW = 1_800_000_000_000;

describe('readChatGptUsageLimit', () => {
  it('reads the ChatGPT backend shape and turns the reset delay into a time', () => {
    const limit = readChatGptUsageLimit(
      429,
      {
        detail: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          plan_type: 'plus',
          resets_in_seconds: 3600,
        },
      },
      NOW
    );

    expect(limit).toEqual({ resetsAt: NOW + 3_600_000 });
  });

  it('reads the API shape and keeps a missing reset delay empty', () => {
    const limit = readChatGptUsageLimit(
      429,
      { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } },
      NOW
    );

    expect(limit).toEqual({ resetsAt: null });
  });

  it('ignores a per-minute rate limit', () => {
    expect(readChatGptUsageLimit(429, { error: { code: 'rate_limit_exceeded' } }, NOW)).toBeNull();
  });

  it('ignores every other status', () => {
    expect(readChatGptUsageLimit(200, { detail: { type: 'usage_limit_reached' } }, NOW)).toBeNull();
    expect(readChatGptUsageLimit(500, { detail: { type: 'usage_limit_reached' } }, NOW)).toBeNull();
  });

  it('ignores a body that carries no limit marker', () => {
    expect(readChatGptUsageLimit(429, { detail: { message: 'slow down' } }, NOW)).toBeNull();
    expect(readChatGptUsageLimit(429, { detail: { type: 'server_error' } }, NOW)).toBeNull();
    expect(readChatGptUsageLimit(429, 'not json', NOW)).toBeNull();
    expect(readChatGptUsageLimit(429, null, NOW)).toBeNull();
  });
});

describe('isChatGptUsageLimitCurrent', () => {
  it('is current until the reported reset', () => {
    const reachedAt = new Date(NOW).toISOString();
    const resetsAt = new Date(NOW + 60_000).toISOString();

    expect(isChatGptUsageLimitCurrent(reachedAt, resetsAt, NOW)).toBe(true);
    expect(isChatGptUsageLimitCurrent(reachedAt, resetsAt, NOW + 60_000)).toBe(false);
  });

  it('accepts the PostgreSQL timestamp shape the row returns', () => {
    expect(
      isChatGptUsageLimitCurrent(
        '2026-04-29 01:16:12.945+00',
        null,
        Date.parse('2026-04-29T02:00:00Z')
      )
    ).toBe(true);
  });

  it('bounds a record with no reported reset to the shorter usage window', () => {
    const reachedAt = new Date(NOW).toISOString();

    expect(isChatGptUsageLimitCurrent(reachedAt, null, NOW + 60_000)).toBe(true);
    expect(
      isChatGptUsageLimitCurrent(reachedAt, null, NOW + USAGE_LIMIT_UNKNOWN_RESET_WINDOW_MS)
    ).toBe(false);
  });

  it('is never current without a recorded limit', () => {
    expect(isChatGptUsageLimitCurrent(null, null, NOW)).toBe(false);
    expect(isChatGptUsageLimitCurrent(undefined, undefined, NOW)).toBe(false);
  });
});
