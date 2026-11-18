import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockUseFeatureFlagEnabled = jest.fn();
const mockUseOrganizationWithMembers = jest.fn();

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('posthog-js/react', () => ({
  useFeatureFlagEnabled: (flag: string) => mockUseFeatureFlagEnabled(flag),
}));
jest.mock('@/hooks/useUser', () => ({
  useUser: () => ({ data: { is_admin: false }, isLoading: false }),
}));
jest.mock('next/navigation', () => ({ usePathname: () => '/organizations/test-org' }));
jest.mock('@/contexts/RoleTestingContext', () => ({
  useRoleTesting: () => ({
    assumedRole: null,
    setAssumedRole: jest.fn(),
    setOriginalRole: jest.fn(),
  }),
}));
jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => mockUseOrganizationWithMembers(),
}));
jest.mock('@/hooks/useOrgKiloClaw', () => ({
  useOrgKiloClawNavState: () => ({ isSuccess: false }),
}));
jest.mock('@/components/ui/sidebar', () => {
  const Content = ({ children }: { children: React.ReactNode }) => children;
  return {
    Sidebar: Content,
    SidebarContent: Content,
    SidebarHeader: Content,
    SidebarRail: () => null,
  };
});
jest.mock('@/components/HeaderLogo', () => () => null);
jest.mock('./OrganizationSwitcher', () => () => null);
jest.mock('./SidebarUserFooter', () => () => null);
jest.mock('./SidebarMenuList', () => ({
  __esModule: true,
  default: ({ items }: { items: Array<{ title: string; url: string }> }) =>
    items.map(item => React.createElement('a', { key: item.url, href: item.url }, item.title)),
}));

function renderSidebar(OrganizationAppSidebar: React.ComponentType<{ organizationId: string }>) {
  return renderToStaticMarkup(
    React.createElement(OrganizationAppSidebar, { organizationId: 'test-org' })
  );
}

describe('OrganizationAppSidebar Request Logs entry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(false);
  });

  it.each([
    { role: 'owner', canView: true },
    { role: 'admin', canView: true },
    { role: 'billing_manager', canView: true },
    { role: 'member', canView: false },
  ] as const)('shows the entry to $role only when authorized', async ({ role, canView }) => {
    mockUseOrganizationWithMembers.mockReturnValue({ data: { callerRole: role } });

    const { default: OrganizationAppSidebar } = await import('./OrganizationAppSidebar');
    const html = renderSidebar(OrganizationAppSidebar);

    expect(html.includes('/organizations/test-org/request-logs')).toBe(canView);
  });
});
