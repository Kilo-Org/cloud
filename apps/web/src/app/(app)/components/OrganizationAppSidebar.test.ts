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

describe('OrganizationAppSidebar Gas Town access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    { environment: 'production', flag: false, role: 'owner', visible: false },
    { environment: 'production', flag: undefined, role: 'owner', visible: false },
    { environment: 'production', flag: true, role: 'owner', visible: true },
    { environment: 'production', flag: true, role: 'member', visible: true },
    { environment: 'production', flag: true, role: 'billing_manager', visible: false },
    { environment: 'development', flag: false, role: 'owner', visible: true },
    { environment: 'development', flag: undefined, role: 'member', visible: true },
    { environment: 'development', flag: true, role: 'billing_manager', visible: false },
  ] as const)('renders the expected entry for %j', async ({ environment, flag, role, visible }) => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: environment });
    mockUseFeatureFlagEnabled.mockImplementation((name: string) =>
      name === 'gastown-access' ? flag : false
    );
    mockUseOrganizationWithMembers.mockReturnValue({ data: { callerRole: role } });

    const { default: OrganizationAppSidebar } = await import('./OrganizationAppSidebar');
    const html = renderToStaticMarkup(
      React.createElement(OrganizationAppSidebar, { organizationId: 'test-org' })
    );

    expect(html.includes('Gas Town')).toBe(visible);
    expect(html.includes('/organizations/test-org/gastown')).toBe(visible);
    expect(html).toContain('Cloud Agent');
    expect(mockUseFeatureFlagEnabled).toHaveBeenCalledWith('gastown-access');
  });
});
