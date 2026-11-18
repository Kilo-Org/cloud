import { describe, expect, it } from '@jest/globals';
import { missingSupportRequestRequirements } from './request-requirements';

describe('missingSupportRequestRequirements', () => {
  it('lists every missing field', () => {
    expect(
      missingSupportRequestRequirements({
        organizationId: '',
        reason: 'debugging',
        durationError: 'Enter a whole number of minutes greater than 0',
      })
    ).toEqual([
      'Select an organization',
      'Reason needs at least 10 characters (9/10)',
      'Enter a whole number of minutes greater than 0',
    ]);
  });

  it('counts the trimmed reason', () => {
    expect(
      missingSupportRequestRequirements({ organizationId: 'org', reason: '   short   ' })
    ).toEqual(['Reason needs at least 10 characters (5/10)']);
  });

  it('returns nothing when the request is complete', () => {
    expect(
      missingSupportRequestRequirements({
        organizationId: 'org',
        reason: 'Investigating a billing ticket',
      })
    ).toEqual([]);
  });
});
