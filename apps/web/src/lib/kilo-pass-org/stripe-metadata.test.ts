import { describe, expect, test } from '@jest/globals';
import { getOrganizationKiloPassMetadata } from './stripe-metadata';

describe('organization Kilo Pass Stripe metadata', () => {
  test('recognizes the explicit combined-subscription metadata shape', () => {
    expect(
      getOrganizationKiloPassMetadata({
        type: 'kilo-pass-org',
        organizationId: 'org_123',
        kiloUserId: 'user_123',
        tier: 'tier_49',
        cadence: 'yearly',
      })
    ).toEqual({
      type: 'kilo-pass-org',
      organizationId: 'org_123',
      kiloUserId: 'user_123',
      tier: 'tier_49',
      cadence: 'yearly',
    });
  });

  test('rejects incomplete metadata so personal and seat-only dispatch remain available', () => {
    expect(getOrganizationKiloPassMetadata({ type: 'kilo-pass-org', tier: 'tier_49' })).toBeNull();
  });
});
