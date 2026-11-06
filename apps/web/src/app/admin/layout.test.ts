jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => ({ evaluateStepUp: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/admin/step-up-observation', () => ({
  reportStepUpFailure: jest.fn(),
}));
jest.mock('./unauthorized/page', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: unknown }) => children,
  SidebarInset: ({ children }: { children: unknown }) => children,
}));
jest.mock('./components/AppSidebar', () => ({ AppSidebar: () => null }));
jest.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
jest.mock('@/app/admin/components/BuildInfo', () => ({ BuildInfo: () => null }));
jest.mock('@/components/AppShellSkipLink', () => ({ AppShellSkipLink: () => null }));
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
const mockEvaluateStepUp = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-store') as {
    evaluateStepUp: jest.Mock;
  }
).evaluateStepUp;
const originalSwitch = process.env.ADMIN_STEP_UP_ENABLED;

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
  process.env.ADMIN_STEP_UP_ENABLED = originalSwitch;
  jest.clearAllMocks();
});

describe('AdminLayout step-up gate', () => {
  it('renders children when the switch is off without evaluating', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'false';
    mockGetUserFromAuth.mockResolvedValue({ user, credential: 'session' } as never);

    const html = await render(React.createElement('div', null, 'PAGE_CONTENT'));

    expect(html).toContain('PAGE_CONTENT');
    expect(mockEvaluateStepUp).not.toHaveBeenCalled();
  });

  it('renders only the interstitial when on and stale', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    mockGetUserFromAuth.mockResolvedValue({
      user,
      credential: 'session',
      webSessionId: 'session-1',
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 1,
    } as never);

    const html = await render(React.createElement('div', null, 'PAGE_CONTENT'));

    expect(html).toContain('INTERSTITIAL:MFA_REQUIRED');
    expect(html).not.toContain('PAGE_CONTENT');
  });

  it('renders children when on and fresh', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    mockGetUserFromAuth.mockResolvedValue({
      user,
      credential: 'session',
      webSessionId: 'session-1',
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: {
        status: 'fresh',
        method: 'webauthn_uv',
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      proof: null,
      passkeyCount: 1,
    } as never);

    const html = await render(React.createElement('div', null, 'PAGE_CONTENT'));

    expect(html).toContain('PAGE_CONTENT');
  });

  it('fails closed when evaluation errors', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    mockGetUserFromAuth.mockResolvedValue({
      user,
      credential: 'session',
      webSessionId: 'session-1',
    } as never);
    mockEvaluateStepUp.mockRejectedValue(new Error('db down') as never);

    const html = await render(React.createElement('div', null, 'PAGE_CONTENT'));

    expect(html).toContain('INTERSTITIAL:STEP_UP_UNAVAILABLE');
    expect(html).not.toContain('PAGE_CONTENT');
  });
});
