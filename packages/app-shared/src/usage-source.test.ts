import { describe, expect, it } from 'vitest';

import { isUsageSourceNotConfigured, USAGE_SOURCE_NOT_CONFIGURED_MESSAGE } from './usage-source';

describe('USAGE_SOURCE_NOT_CONFIGURED_MESSAGE', () => {
  it('differs from the retryable warehouse-failure message', () => {
    // A client tells "the workspace has no usage source" (permanent) apart
    // from "the warehouse failed" (retryable) by the message alone; sharing a
    // string with 'Usage data temporarily unavailable' would collapse them.
    expect(USAGE_SOURCE_NOT_CONFIGURED_MESSAGE).not.toBe('Usage data temporarily unavailable');
  });
});

describe('isUsageSourceNotConfigured', () => {
  it('accepts the exact unconfigured-source message', () => {
    expect(isUsageSourceNotConfigured('Usage source not configured')).toBe(true);
    expect(isUsageSourceNotConfigured(USAGE_SOURCE_NOT_CONFIGURED_MESSAGE)).toBe(true);
  });

  it('refuses the retryable warehouse-failure message and other text', () => {
    expect(isUsageSourceNotConfigured('Usage data temporarily unavailable')).toBe(false);
    expect(isUsageSourceNotConfigured('Usage source not configured ')).toBe(false);
    expect(isUsageSourceNotConfigured(undefined)).toBe(false);
    expect(isUsageSourceNotConfigured('')).toBe(false);
  });
});
