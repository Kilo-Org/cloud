import { describe, expect, it } from 'vitest';

import { getKiloPassSubscriptionCardAccessibility } from './subscription-card-state';

describe('getKiloPassSubscriptionCardAccessibility', () => {
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
});
