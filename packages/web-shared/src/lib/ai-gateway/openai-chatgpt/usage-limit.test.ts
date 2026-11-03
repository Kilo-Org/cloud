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

    expect(limit).toEqual({ code: 'usage_limit_reached', resetsAt: NOW + 3_600_000 });
  });

  it('reads the API shape and keeps a missing reset delay empty', () => {
    const limit = readChatGptUsageLimit(
      429,
      { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } },
      NOW
    );

    expect(limit).toEqual({ code: 'insufficient_quota', resetsAt: null });
  });

  it('reads the documented sharing code of a delegated request', () => {
    const limit = readChatGptUsageLimit(
      429,
      {
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          message: 'You have reached your usage limit for sharing',
        },
      },
      NOW
    );

    // OpenAI reports no reset time for this code, and the notice must not claim
    // one: the recorded window only bounds how long the message stays up.
    expect(limit).toEqual({ code: 'subscription_sharing_usage_limit_exceeded', resetsAt: null });
  });

  it('reads the sharing code when the body carries a reset delay', () => {
    const limit = readChatGptUsageLimit(
      429,
      {
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          resets_in_seconds: 3600,
        },
      },
      NOW
    );

    expect(limit).toEqual({
      code: 'subscription_sharing_usage_limit_exceeded',
      resetsAt: NOW + 3_600_000,
    });
  });

  it.each([
    { error: { code: 'subscription_sharing_workplace_individual_usage_limit_exceeded' } },
    { detail: { type: 'subscription_sharing_workplace_individual_usage_limit_exceeded' } },
  ])('identifies a workspace limit separately from a consumer limit', body => {
    expect(readChatGptUsageLimit(429, body, NOW)).toEqual({
      code: 'subscription_sharing_workplace_individual_usage_limit_exceeded',
      resetsAt: null,
    });
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
