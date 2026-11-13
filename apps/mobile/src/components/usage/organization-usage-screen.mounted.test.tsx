// The usage route is a universal link (`/organizations/<id>/usage-details?org=`):
// the money numbers belong to the organization the link names, so that
// organization becomes the selection exactly as it does for credit activity.
// A foreign id writes nothing and stays on the boundary's denied state, and a
// route without the param leaves the persisted selection alone.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { renderWithProviders } from '@/test/render-with-providers';

import OrganizationUsageRoute from '@/app/(app)/(tabs)/(3_profile)/organization/usage';

const route = vi.hoisted(() => ({
  org: undefined as string | string[] | undefined,
}));

const organizationList = vi.hoisted(() => ({
  entries: [] as { organizationId: string; role: string }[],
}));

const boundaries = vi.hoisted(() => ({
  rendered: [] as { title?: string; organizationIdOverride?: string }[],
}));

const account = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  written: [] as (string | null)[],
  setOrganizationId: vi.fn(),
  reset() {
    account.organizationId = 'org-1';
    account.written = [];
    account.setOrganizationId.mockClear();
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ org: route.org }),
}));

vi.mock('@/lib/hooks/use-leave-stale-organization-scope', () => ({
  useLeaveStaleOrganizationScope: () => false,
}));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: (role?: string) => role === 'owner' || role === 'billing_manager',
  useOrgBoundary: (override?: string) => {
    const organizationId = override ?? account.organizationId;
    const org = organizationList.entries.find(entry => entry.organizationId === organizationId);
    return {
      organizationId,
      contextOrganizationId: account.organizationId,
      role: org?.role,
      org,
      orgs: organizationList.entries,
      isLoading: false,
      isResolving: false,
    };
  },
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: account.organizationId,
    isLoaded: true,
    setOrganizationId: account.setOrganizationId,
  }),
}));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: (props: { title?: string; organizationIdOverride?: string }) => {
    boundaries.rendered.push(props);
    return null;
  },
}));

vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'DetailScreenScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/usage/usage-content', () => ({ UsageContent: 'UsageContent' }));
vi.mock('react-native', () => ({ View: 'View' }));

async function renderRoute() {
  const ui = await renderWithProviders(createElement(OrganizationUsageRoute));
  return ui;
}

beforeEach(() => {
  account.reset();
  account.setOrganizationId.mockImplementation((next: string | null) => {
    account.written.push(next);
  });
  organizationList.entries = [
    { organizationId: 'org-1', role: 'owner' },
    { organizationId: 'org-b', role: 'owner' },
    { organizationId: 'org-c', role: 'member' },
  ];
  boundaries.rendered = [];
  route.org = undefined;
});

describe('organization usage route deep-linked organization', () => {
  it('writes the linked member organization as the selection', async () => {
    route.org = 'org-b';

    const ui = await renderRoute();

    expect(account.written).toEqual(['org-b']);
    expect(boundaries.rendered).toHaveLength(0);
    ui.unmount();
  });

  it('takes the first of a repeated org parameter', async () => {
    route.org = ['org-b', 'org-c'];

    const ui = await renderRoute();

    expect(account.written).toEqual(['org-b']);
    ui.unmount();
  });

  it('writes nothing for an organization the viewer is not a member of', async () => {
    route.org = 'org-foreign';

    const ui = await renderRoute();

    expect(account.written).toEqual([]);
    expect(boundaries.rendered).toHaveLength(1);
    expect(boundaries.rendered[0]?.organizationIdOverride).toBe('org-foreign');
    ui.unmount();
  });

  it.each([undefined, '', ['', 'org-b']] as const)(
    'leaves the selection alone for %j',
    async org => {
      route.org = org;

      const ui = await renderRoute();

      expect(account.written).toEqual([]);
      ui.unmount();
    }
  );
});
