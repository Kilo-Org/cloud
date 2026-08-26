import { describe, expect, it } from '@jest/globals';
import { computeBillingRefetchInterval } from './ChatHeader';

describe('computeBillingRefetchInterval', () => {
  it('stops polling while idle and resumes when the live session becomes active', () => {
    expect(computeBillingRefetchInterval(false, 'idle')).toBe(false);
    expect(computeBillingRefetchInterval(true, 'idle')).toBe(5_000);
  });
});
