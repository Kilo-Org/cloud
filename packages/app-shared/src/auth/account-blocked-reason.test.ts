import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_BLOCKED_REFUSAL_REASONS,
  accountBlockedRefusalReason,
} from './account-blocked-reason';

describe('accountBlockedRefusalReason', () => {
  it.each(ACCOUNT_BLOCKED_REFUSAL_REASONS)('round-trips %s', reason => {
    expect(accountBlockedRefusalReason(reason)).toBe(reason);
  });

  it('rejects an unknown string', () => {
    expect(accountBlockedRefusalReason('account_locked')).toBeNull();
    expect(accountBlockedRefusalReason('')).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(accountBlockedRefusalReason(undefined)).toBeNull();
    expect(accountBlockedRefusalReason(null)).toBeNull();
    expect(accountBlockedRefusalReason(0)).toBeNull();
    expect(accountBlockedRefusalReason({ reason: 'account_blocked' })).toBeNull();
  });
});
