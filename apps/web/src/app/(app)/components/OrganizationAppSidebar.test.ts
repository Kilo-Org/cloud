import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockUseFeatureFlagEnabled = jest.fn();
const mockUseOrganizationWithMembers = jest.fn();
const mockUseRequestLogsAvailable = jest.fn();

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
jest.mock('@/hooks/useRequestLogsAvailable', () => ({
  useRequestLogsAvailable: (organizationId: string, canView: boolean) =>
    mockUseRequestLogsAvailable(organizationId, canView),
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
  ] as const)('only lets $role check availability when allowed', async ({ role, canView }) => {
    mockUseOrganizationWithMembers.mockReturnValue({ data: { callerRole: role } });
    mockUseRequestLogsAvailable.mockReturnValue(false);

    const { default: OrganizationAppSidebar } = await import('./OrganizationAppSidebar');
    renderSidebar(OrganizationAppSidebar);

    expect(mockUseRequestLogsAvailable).toHaveBeenCalledWith('test-org', canView);
  });

  it.each([true, false])('shows the entry only when available (%s)', async available => {
    mockUseOrganizationWithMembers.mockReturnValue({ data: { callerRole: 'owner' } });
    mockUseRequestLogsAvailable.mockReturnValue(available);

    const { default: OrganizationAppSidebar } = await import('./OrganizationAppSidebar');
    const html = renderSidebar(OrganizationAppSidebar);

    expect(html.includes('/organizations/test-org/request-logs')).toBe(available);
  });
});
