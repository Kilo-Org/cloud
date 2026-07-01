import React, { type ReactNode } from 'react';
import type { User } from '@kilocode/db/schema';
import { defineTestUser } from '@/tests/helpers/user.helper';

const mockGetUserFromAuthOrRedirect = jest.fn<Promise<User>, []>();

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: () => mockGetUserFromAuthOrRedirect(),
}));

jest.mock('@/components/usage-analytics/UsageAnalyticsDashboard', () => ({
  UsageAnalyticsDashboard: () => null,
}));

jest.mock('@/components/security-agent/SecurityAgentContext', () => ({
  SecurityAgentProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/components/security-agent/SecurityAgentLayout', () => ({
  SecurityAgentLayout: ({ children }: { children: ReactNode }) => children,
}));

type ProtectedRouteEntry = {
  route: string;
  render: () => Promise<ReactNode>;
};

async function renderSecurityAgentLayout(): Promise<ReactNode> {
  const { default: SecurityAgentRootLayout } = await import('@/app/(app)/security-agent/layout');
  return SecurityAgentRootLayout({ children: 'security agent content' });
}

const protectedRouteEntries: ProtectedRouteEntry[] = [
  {
    route: '/usage',
    render: async () => {
      const { default: UsagePage } = await import('@/app/(app)/usage/page');
      return UsagePage();
    },
  },
  {
    route: '/security-agent/config',
    render: renderSecurityAgentLayout,
  },
  {
    route: '/security-agent/audit-report',
    render: renderSecurityAgentLayout,
  },
];

describe('protected app routes', () => {
  const redirectSentinel = new Error('NEXT_REDIRECT');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(protectedRouteEntries)('checks authentication before rendering $route', async entry => {
    mockGetUserFromAuthOrRedirect.mockResolvedValue(defineTestUser());

    await expect(entry.render()).resolves.toBeDefined();
    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledTimes(1);
  });

  it.each(protectedRouteEntries)(
    'propagates the unauthenticated redirect for $route',
    async entry => {
      mockGetUserFromAuthOrRedirect.mockRejectedValue(redirectSentinel);

      await expect(entry.render()).rejects.toBe(redirectSentinel);
      expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledTimes(1);
    }
  );
});
