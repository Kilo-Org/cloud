jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('./unauthorized/page', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: unknown }) => children,
  SidebarInset: ({ children }: { children: unknown }) => children,
}));
jest.mock('./components/AppSidebar', () => ({ AppSidebar: () => null }));
jest.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
jest.mock('@/app/admin/components/BuildInfo', () => ({ BuildInfo: () => null }));
jest.mock('@/components/AppShellSkipLink', () => ({ AppShellSkipLink: () => null }));
jest.mock('@/app/admin/components/AdminAccessDenied', () => ({
  AdminAccessDenied: ({ message }: { message: string }) => `ACCESS_DENIED:${message}`,
}));
jest.mock('@/components/admin/step-up/StepUpProvider', () => ({
  StepUpProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock('@/components/admin/step-up/AdminStepUpInterstitial', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  return {
    AdminStepUpInterstitial: ({ requirement }: { requirement: { code: string } }) =>
      ReactActual.createElement('div', null, `INTERSTITIAL:${requirement.code}`),
  };
});

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockGetUserFromAuth = (
  jest.requireMock('@kilocode/web-shared/lib/user/server') as { getUserFromAuth: jest.Mock }
).getUserFromAuth;

import type AdminLayoutDefault from './layout';
type Layout = typeof AdminLayoutDefault;
let AdminLayout!: Layout;

const user = { id: 'admin-1', is_admin: true };

async function render(children: React.ReactNode): Promise<string> {
  const element = await AdminLayout({ children });
  return renderToStaticMarkup(element as React.ReactElement);
}

beforeAll(async () => {
  ({ default: AdminLayout } = await import('./layout'));
});

afterEach(() => {
  jest.clearAllMocks();
});

function stepUpRefusal(code: string) {
  return {
    user: null,
    stepUp: {
      code,
      actionClass: 'platform_read',
      purpose: 'session',
      maxAgeSeconds: 1800,
      binding: null,
    },
  };
}

describe('AdminLayout staff admission', () => {
  it('runs the server-component admission, with no exemption from step-up', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user, credential: 'session' } as never);

    const html = await render(React.createElement('div', null, 'PAGE_CONTENT'));

    expect(html).toContain('PAGE_CONTENT');
    expect(mockGetUserFromAuth).toHaveBeenCalledWith({
      adminOnly: true,
      stepUpSurface: 'server-component',
    });
  });

  it.each(['MFA_REQUIRED', 'SESSION_UNBOUND', 'BEARER_NOT_ALLOWED', 'STEP_UP_UNAVAILABLE'])(
    'renders only the interstitial for %s',
    async code => {
      mockGetUserFromAuth.mockResolvedValue(stepUpRefusal(code) as never);

      const html = await render(React.createElement('div', null, 'PAGE_CONTENT'));

      expect(html).toContain(`INTERSTITIAL:${code}`);
      expect(html).not.toContain('PAGE_CONTENT');
    }
  );

  it('renders the non-admin page for any other refusal', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null } as never);

    const html = await render(React.createElement('div', null, 'PAGE_CONTENT'));

    expect(html).not.toContain('INTERSTITIAL');
    expect(html).not.toContain('PAGE_CONTENT');
  });
});

describe('AdminLayout admin network refusal', () => {
  it('shows the WARP message, not the non-admin page, to an off-network admin', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      adminNetworkDenial: 'outside-allowlist',
    } as never);

    const html = await render(React.createElement('div', null, 'PAGE_CONTENT'));

    expect(html).toContain('ACCESS_DENIED:');
    expect(html).toContain('Cloudflare WARP');
    expect(html).not.toContain('PAGE_CONTENT');
  });
});
