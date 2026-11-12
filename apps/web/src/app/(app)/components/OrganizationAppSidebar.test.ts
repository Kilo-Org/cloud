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
  default: ({
    label,
    items,
  }: {
    label: string | null;
    items: Array<{ title: string; url: string }>;
  }) =>
    React.createElement(
      'section',
      { 'data-label': label ?? '' },
      items.map(item => React.createElement('a', { key: item.url, href: item.url }, item.title))
    ),
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

function groupLabels(html: string): string[] {
  return [...html.matchAll(/data-label="([^"]*)"/g)]
    .map(match => match[1])
    .filter(label => label.length > 0);
}

function groupHtml(html: string, label: string): string {
  const match = html.match(new RegExp(`<section data-label="${label}">([\\s\\S]*?)</section>`));
  return match?.[1] ?? '';
}

describe('OrganizationAppSidebar groups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(false);
  });

  it('orders groups for an enterprise owner of a root organization', async () => {
    mockUseOrganizationWithMembers.mockReturnValue({
      data: { callerRole: 'owner', plan: 'enterprise', parent_organization_id: null },
    });

    const { default: OrganizationAppSidebar } = await import('./OrganizationAppSidebar');
    const html = renderSidebar(OrganizationAppSidebar);
    const admin = groupHtml(html, 'Admin');

    expect(groupLabels(html)).toEqual(['Overview', 'Cloud', 'Settings', 'Admin', 'Billing']);
    expect(html).not.toContain('data-label="Dashboard"');
    expect(html).not.toContain('data-label="Account"');
    expect(admin).toContain('Sub-organizations');
    expect(admin.indexOf('>Groups<')).toBeLessThan(admin.indexOf('>Model Access<'));
    expect(admin.indexOf('>Model Access<')).toBeLessThan(admin.indexOf('>Audit Logs<'));
    expect(admin.indexOf('>Audit Logs<')).toBeLessThan(admin.indexOf('>Sub-organizations<'));
  });

  it('hides Admin and Billing for a non-enterprise member', async () => {
    mockUseOrganizationWithMembers.mockReturnValue({
      data: { callerRole: 'member', plan: 'teams', parent_organization_id: null },
    });

    const { default: OrganizationAppSidebar } = await import('./OrganizationAppSidebar');
    const html = renderSidebar(OrganizationAppSidebar);

    expect(groupLabels(html)).toEqual(['Overview', 'Cloud', 'Settings']);
    expect(html).not.toContain('data-label="Admin"');
    expect(html).not.toContain('data-label="Billing"');
  });

  it('keeps Groups visible to enterprise members and hides owner-only admin pages', async () => {
    mockUseOrganizationWithMembers.mockReturnValue({
      data: { callerRole: 'member', plan: 'enterprise', parent_organization_id: 'parent-org' },
    });

    const { default: OrganizationAppSidebar } = await import('./OrganizationAppSidebar');
    const html = renderSidebar(OrganizationAppSidebar);
    const admin = groupHtml(html, 'Admin');

    expect(admin).toContain('Groups');
    expect(admin).not.toContain('Model Access');
    expect(admin).not.toContain('Audit Logs');
    expect(html).not.toContain('data-label="Billing"');
  });
});
