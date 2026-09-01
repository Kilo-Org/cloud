import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OverviewSection } from './SubOrganizationSections';

globalThis.React = React;

const overview = {
  canCreateSubOrganizations: false,
  children: [
    {
      id: 'd69f3c69-2fe8-4752-bd91-8a493b8581b3',
      name: 'Child organization',
      plan: 'enterprise' as const,
      requireSeats: true,
      memberCount: 4,
      pendingInvitationCount: 0,
      seatCount: { used: 4, total: 10 },
      balanceMicrodollars: 25_000_000,
    },
  ],
};

describe('OverviewSection usage data states', () => {
  it('keeps organization details visible when usage data is unavailable', () => {
    const html = renderToStaticMarkup(
      React.createElement(OverviewSection, {
        organizationId: '4ab109e4-2558-4290-84d8-894bd50bbdac',
        data: overview,
        spendByOrganization: new Map(),
        usageDataStatus: 'unavailable',
      })
    );

    expect(html).toContain('Child organization');
    expect(html).toContain('30-day usage data is temporarily unavailable');
    expect(html).toContain('Unavailable');
  });

  it('shows spend when usage data is available', () => {
    const html = renderToStaticMarkup(
      React.createElement(OverviewSection, {
        organizationId: '4ab109e4-2558-4290-84d8-894bd50bbdac',
        data: overview,
        spendByOrganization: new Map([[overview.children[0].id, 1_500_000]]),
        usageDataStatus: 'available',
      })
    );

    expect(html).toContain('$1.50');
    expect(html).not.toContain('temporarily unavailable');
  });
});
