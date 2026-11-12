import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/hooks/useUser', () => ({
  useUser: () => ({ data: { is_admin: false }, isLoading: false }),
}));
jest.mock('@/hooks/useKiloClaw', () => ({
  useKiloClawNavState: () => ({ isSuccess: false }),
}));
jest.mock('next/navigation', () => ({ usePathname: () => '/profile' }));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    kiloPass: {
      getSidebarPromoEligibility: {
        queryOptions: () => ({}),
      },
    },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
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
jest.mock('./SidebarPromoBanner', () => () => null);
jest.mock('./SidebarUserFooter', () => () => null);
jest.mock('./SidebarMenuList', () => ({
  __esModule: true,
  default: ({
    label,
    items,
  }: {
    label: string | null;
    items: Array<{ title: string; url?: string }>;
  }) =>
    React.createElement(
      'section',
      { 'data-label': label ?? '' },
      items.map(item =>
        React.createElement('a', { key: item.url ?? item.title, href: item.url }, item.title)
      )
    ),
}));

function groupLabels(html: string): string[] {
  return [...html.matchAll(/data-label="([^"]*)"/g)]
    .map(match => match[1])
    .filter(label => label.length > 0);
}

describe('PersonalAppSidebar groups', () => {
  it('shows Overview, Cloud, Settings, and Billing with no Admin group', async () => {
    const { default: PersonalAppSidebar } = await import('./PersonalAppSidebar');
    const html = renderToStaticMarkup(React.createElement(PersonalAppSidebar));

    expect(groupLabels(html)).toEqual(['Overview', 'Cloud', 'Settings', 'Billing']);
    expect(html).not.toContain('data-label="Dashboard"');
    expect(html).not.toContain('data-label="Account"');
    expect(html).not.toContain('data-label="Admin"');
    expect(html.indexOf('>Cloud Agent<')).toBeLessThan(html.indexOf('>Sessions<'));
    expect(html.indexOf('>Sessions<')).toBeLessThan(html.indexOf('>Webhooks / Triggers<'));
    expect(html.indexOf('>Webhooks / Triggers<')).toBeLessThan(html.indexOf('>Code Reviewer<'));
    expect(html.indexOf('>Code Reviewer<')).toBeLessThan(html.indexOf('>Security Agent<'));
    expect(html.indexOf('>Integrations<')).toBeLessThan(
      html.indexOf('>Bring Your Own Key (BYOK)<')
    );
    expect(html.indexOf('>Subscriptions<')).toBeLessThan(html.indexOf('>Invoices<'));
    expect(html.indexOf('>Invoices<')).toBeLessThan(html.indexOf('>Credits<'));
  });
});
