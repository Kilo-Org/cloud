import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { getKiloPassSubscriptionCardAccessibility } from './subscription-card-state';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

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

  it('closes each sentence with the catalog’s own terminator', async () => {
    await i18n.changeLanguage('ja');
    const { accessibilityLabel } = getKiloPassSubscriptionCardAccessibility({
      action: 'open-web',
      actionLabel: '管理',
      description: '$49 monthly credits · Managed on web',
      title: 'Kilo Pass active',
    });
    expect(accessibilityLabel).toBe('Kilo Pass active。$49 monthly credits · Managed on web。管理');
  });
});
