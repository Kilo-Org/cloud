import { describe, expect, test } from '@jest/globals';
import { getOrganizationKiloPassMetadata } from './stripe-metadata';

describe('organization Kilo Pass Stripe metadata', () => {
  test('rejects incomplete metadata so personal and seat-only dispatch remain available', () => {
    expect(getOrganizationKiloPassMetadata({ type: 'kilo-pass-org', tier: 'tier_49' })).toBeNull();
  });
});
