import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockUseQuery = jest.fn();
const mockQueryOptions = jest.fn((_input, options) => options);
const mockPush = jest.fn();

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({ userExports: { uiAccess: { queryOptions: mockQueryOptions } } }),
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));
jest.mock('@/components/ui/sidebar', () => ({
  SidebarFooter: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/ui/dropdown-menu', () => {
  const Content = ({ children }: { children: React.ReactNode }) => children;
  return {
    DropdownMenu: Content,
    DropdownMenuContent: Content,
    DropdownMenuItem: Content,
    DropdownMenuTrigger: Content,
    DropdownMenuSeparator: () => null,
  };
});

const user = {
  google_user_email: 'export-user@example.com',
  google_user_name: 'Export User',
  google_user_image_url: '',
};

describe('SidebarUserFooter export entry shared by personal and organization sidebars', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function renderFooter(isLoading = false) {
    const { default: SidebarUserFooter } = await import('./SidebarUserFooter');
    return renderToStaticMarkup(React.createElement(SidebarUserFooter, { user, isLoading }));
  }

  it('shows the export entry only for a successful enabled result for this user', async () => {
    mockUseQuery.mockReturnValue({
      data: { enabled: true, email: user.google_user_email },
      isSuccess: true,
    });

    expect(await renderFooter()).toContain('Request data export');
    expect(mockQueryOptions).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: true })
    );
  });

  it.each([
    { data: { enabled: false, email: user.google_user_email }, isSuccess: true },
    { data: undefined, isSuccess: false },
    { data: { enabled: undefined, email: user.google_user_email }, isSuccess: true },
    { data: { enabled: true, email: user.google_user_email }, isSuccess: false },
    { data: { enabled: true, email: 'previous-user@example.com' }, isSuccess: true },
  ])('hides export but preserves other menu entries for %j', async result => {
    mockUseQuery.mockReturnValue(result);

    const html = await renderFooter();

    expect(html).not.toContain('Request data export');
    expect(html).toContain('Connected Accounts');
    expect(html).toContain('Install');
    expect(html).toContain('Learn');
    expect(html).toContain('Sign out');
  });

  it('keeps the standalone view fail-closed without a query provider', async () => {
    const { SidebarUserFooterView } = await import('./SidebarUserFooter');
    const html = renderToStaticMarkup(
      React.createElement(SidebarUserFooterView, { user, isLoading: false })
    );

    expect(html).toContain('Connected Accounts');
    expect(html).not.toContain('Request data export');
    expect(mockUseQuery).not.toHaveBeenCalled();
  });

  it('does not query or show export while the user is loading', async () => {
    mockUseQuery.mockReturnValue({
      data: { enabled: true, email: user.google_user_email },
      isSuccess: true,
    });

    expect(await renderFooter(true)).not.toContain('Request data export');
    expect(mockQueryOptions).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false })
    );
  });
});
