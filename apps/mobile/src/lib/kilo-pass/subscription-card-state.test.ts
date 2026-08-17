import { describe, expect, it } from 'vitest';

import { getKiloPassSubscriptionCardAccessibility } from './subscription-card-state';

describe('getKiloPassSubscriptionCardAccessibility', () => {
  it('describes the subscribe action', () => {
    expect(
      getKiloPassSubscriptionCardAccessibility({
        action: 'open-native',
        actionLabel: 'Subscribe',
        description: 'Monthly credits with bonus progress',
        title: 'Kilo Pass',
      })
    ).toEqual({
      accessibilityHint: 'Opens Kilo Pass plans.',
      accessibilityLabel: 'Kilo Pass. Monthly credits with bonus progress. Subscribe',
    });
  });

  it('describes App Store management', () => {
    expect(
      getKiloPassSubscriptionCardAccessibility({
        action: 'open-store-management',
        actionLabel: 'Manage',
        description: '$19 monthly credits · Managed in App Store',
        title: 'Kilo Pass active',
      })
    ).toEqual({
      accessibilityHint: 'Opens App Store subscription management.',
      accessibilityLabel: 'Kilo Pass active. $19 monthly credits · Managed in App Store. Manage',
    });
  });

  it('describes web management', () => {
    expect(
      getKiloPassSubscriptionCardAccessibility({
        action: 'open-web',
        actionLabel: 'Manage',
        description: '$49 monthly credits · Managed on web',
        title: 'Kilo Pass active',
      })
    ).toEqual({
      accessibilityHint: 'Opens Kilo Pass management on web.',
      accessibilityLabel: 'Kilo Pass active. $49 monthly credits · Managed on web. Manage',
    });
  });

  it('omits the hint for inert cards', () => {
    expect(
      getKiloPassSubscriptionCardAccessibility({
        action: 'none',
        actionLabel: null,
        description: '$49 monthly credits · Managed on Google Play',
        title: 'Kilo Pass active',
      })
    ).toEqual({
      accessibilityHint: undefined,
      accessibilityLabel: 'Kilo Pass active. $49 monthly credits · Managed on Google Play',
    });
  });
});
