import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OverviewSection, PeopleSection } from './SubOrganizationSections';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  usePathname: () => '/organizations/parent/sub-organizations/people',
  useSearchParams: () => new URLSearchParams(),
}));

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

describe('PeopleSection direct owners', () => {
  it('distinguishes direct child owners from inherited administrative permissions', () => {
    const data: React.ComponentProps<typeof PeopleSection>['data'] = {
      children: [
        {
          id: '4ab109e4-2558-4290-84d8-894bd50bbdac',
          name: 'Empty child',
          memberCount: 2,
          pendingInvitationCount: 0,
          seatCount: { used: 2, total: 5 },
          roleBreakdown: { owner: 0, admin: 0, billing_manager: 0, member: 2 },
          owners: [],
        },
        {
          id: 'd69f3c69-2fe8-4752-bd91-8a493b8581b3',
          name: 'Owned child',
          memberCount: 2,
          pendingInvitationCount: 0,
          seatCount: { used: 2, total: 5 },
          roleBreakdown: { owner: 2, admin: 0, billing_manager: 0, member: 0 },
          owners: [
            { kiloUserId: 'owner-1', name: 'Alice', email: 'alice@example.com' },
            { kiloUserId: 'owner-2', name: 'Bob', email: 'bob@example.com' },
          ],
        },
      ],
      people: [
        {
          identityKey: 'parent@example.com',
          kiloUserId: 'parent-owner',
          name: 'Parent owner',
          email: 'parent@example.com',
          parentMembership: { role: 'owner', status: 'accepted' },
          memberships: [],
          invitations: [],
          statuses: ['accepted'],
        },
      ],
      pageInfo: { page: 1, pageSize: 25, total: 1, pageCount: 1 },
    };
    const html = renderToStaticMarkup(React.createElement(PeopleSection, { data }));
    const table = html.split('</table>')[0];
    const rows = table.split('</tr>');
    const emptyChildRow = rows.find(row => row.includes('Empty child'));
    const ownedChildRow = rows.find(row => row.includes('Owned child'));

    expect(html).toContain('Parent owner');
    expect(ownedChildRow).toContain('Alice, Bob');
    expect(emptyChildRow).not.toContain('Parent owner');
    expect(ownedChildRow).not.toContain('Parent owner');
    expect(emptyChildRow).toContain('No direct owner');
    expect(table).toContain('Direct owners');
    expect(html).toContain(
      'Users with administrative permissions in the parent organization retain those permissions'
    );
    expect(html).toContain('regardless of whether they have a direct membership.');
  });
});

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
