import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KiloPassUsageCardView } from './KiloPassUsageCard';

describe('KiloPassUsageCardView', () => {
  test('shows current parent and child Kilo Pass usage', () => {
    const html = renderToStaticMarkup(
      React.createElement(KiloPassUsageCardView, {
        organizationId: '4d2f6bf9-9a5e-4614-8e5e-39e68d747acd',
        fullMonthlyCreditsPerPassUsd: 19,
        allocations: [
          {
            organizationId: '7b64f360-7a87-4483-a614-ccfdf061e184',
            organizationName: 'Acme Co',
            kind: 'parent',
            passCount: 25,
            baseCreditsUsd: 442.67,
            qualifyingSpendUsd: 0,
            unlockTargetUsd: 442.67,
            bonusCreditsUsd: 93.19,
            bonusState: 'locked',
          },
          {
            organizationId: '0b575b69-03f6-477c-8b20-bb2ad726c320',
            organizationName: 'Engineering',
            kind: 'child',
            passCount: 0,
            baseCreditsUsd: 0,
            qualifyingSpendUsd: 0,
            unlockTargetUsd: 0,
            bonusCreditsUsd: 0,
            bonusState: 'locked',
          },
        ],
      })
    );

    expect(html).toContain('Kilo Pass Usage');
    expect(html).toContain('Current monthly Credits and bonus progress by organization.');
    expect(html).toContain('Acme Co');
    expect(html).toContain('25 passes · $442.67 monthly Credits');
    expect(html).toContain('$0 of $442.67 spent');
    expect(html).toContain('$93.19 bonus Credits');
    expect(html).toContain('Engineering');
    expect(html).toContain('No passes assigned for this period');
    expect(html).toContain(
      'href="/organizations/4d2f6bf9-9a5e-4614-8e5e-39e68d747acd/subscriptions/kilo-pass"'
    );
  });

  test('hides subscription management from members', () => {
    const html = renderToStaticMarkup(
      React.createElement(KiloPassUsageCardView, {
        organizationId: '4d2f6bf9-9a5e-4614-8e5e-39e68d747acd',
        fullMonthlyCreditsPerPassUsd: 19,
        canManageSubscription: false,
        allocations: [],
      })
    );

    expect(html).toContain('Kilo Pass Usage');
    expect(html).not.toContain('Manage Subscription');
  });
});
