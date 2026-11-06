jest.mock('@/lib/organizations/organization-auth', () => ({
  getAuthorizedOrgContext: jest.fn(),
  getAuthorizedOrgContextOrSupport: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/admin/support-access', () => ({
  isSupportAccessEnabled: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  signInUrlWithCallbackPath: jest.fn(),
}));
jest.mock('next/navigation', () => ({ redirect: jest.fn() }));
jest.mock('./OrganizationTrialWrapper', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  return {
    OrganizationTrialWrapper: ({
      children,
      role,
      organizationId,
    }: {
      children: React.ReactNode;
      role: string;
      organizationId: string;
    }) =>
      ReactActual.createElement(
        'section',
        { 'data-role': role, 'data-org': organizationId },
        children
      ),
  };
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  getAuthorizedOrgContext,
  getAuthorizedOrgContextOrSupport,
} from '@/lib/organizations/organization-auth';
import type * as OrganizationAuth from '@/lib/organizations/organization-auth';
import type * as SupportAccess from '@kilocode/web-shared/lib/admin/support-access';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { OrganizationByPageLayout as Layout } from './OrganizationByPageLayout';

type PageRenderProps = Parameters<Parameters<typeof Layout>[0]['render']>[0];

const previousReact = Reflect.get(globalThis, 'React');

const {
  getAuthorizedOrgContext: mockGetAuthorizedOrgContext,
  getAuthorizedOrgContextOrSupport: mockGetAuthorizedOrgContextOrSupport,
} = jest.requireMock<typeof OrganizationAuth>('@/lib/organizations/organization-auth');
const { isSupportAccessEnabled: mockIsSupportAccessEnabled } = jest.requireMock<
  typeof SupportAccess
>('@kilocode/web-shared/lib/admin/support-access');
const mockAuth = jest.mocked(mockGetAuthorizedOrgContext);
const mockSupportAuth = jest.mocked(mockGetAuthorizedOrgContextOrSupport);
const mockSupportEnabled = jest.mocked(mockIsSupportAccessEnabled);
let OrganizationByPageLayout: typeof Layout;

beforeAll(async () => {
  Reflect.set(globalThis, 'React', React);
  ({ OrganizationByPageLayout } = await import('./OrganizationByPageLayout'));
});

afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Reflect.set(globalThis, 'React', previousReact);
});
const organization = { id: 'org-1' } as PageRenderProps['organization'];
const params = Promise.resolve({ id: 'org-1' });

describe('OrganizationByPageLayout', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it.each(['owner', 'admin', 'billing_manager'] as const)(
    'forwards inherited %s access to the page and trial wrapper',
    async (role: OrganizationRole) => {
      mockSupportEnabled.mockReturnValue(true);
      mockAuth.mockResolvedValue({
        success: true,
        data: { user: { role, is_admin: false }, organization, access: { kind: 'member', role } },
      } as Awaited<ReturnType<typeof getAuthorizedOrgContext>>);
      const render = jest.fn(({ role: pageRole, isGlobalAdmin }: PageRenderProps) =>
        React.createElement('div', null, `${pageRole}:${isGlobalAdmin}`)
      );

      const html = renderToStaticMarkup(await OrganizationByPageLayout({ params, render }));

      expect(mockAuth).toHaveBeenCalledWith('org-1', undefined, {
        surface: 'server-component',
      });
      expect(mockSupportAuth).not.toHaveBeenCalled();
      expect(render).toHaveBeenCalledWith({ role, organization, isGlobalAdmin: false });
      expect(html).toContain(`data-role="${role}"`);
      expect(html).toContain(`${role}:false`);
      expect(html).not.toContain('Support read access');
    }
  );

  it.each([true, false])('keeps support read access scoped when flag is %s', async enabled => {
    mockSupportEnabled.mockReturnValue(enabled);
    const access = {
      kind: 'support' as const,
      grantId: 'grant-12345678',
      organizationId: 'org-1',
      actionClass: 'support_read' as const,
      expiresAt: '2030-01-01T00:00:00.000Z',
      supportActionId: 'action-1',
      inventoryId: null,
    };
    mockSupportAuth.mockResolvedValue({
      success: true,
      data: { user: { role: 'member', is_admin: true }, organization, access },
    } as Awaited<ReturnType<typeof getAuthorizedOrgContextOrSupport>>);
    const render = jest.fn(({ role, isGlobalAdmin }: PageRenderProps) =>
      React.createElement('div', null, `${role}:${isGlobalAdmin}`)
    );

    const html = renderToStaticMarkup(
      await OrganizationByPageLayout({ params, render, supportRead: true })
    );

    expect(mockSupportAuth).toHaveBeenCalledWith('org-1', '/organizations/[id]', undefined, {
      surface: 'server-component',
    });
    expect(mockAuth).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith({ role: 'member', organization, isGlobalAdmin: false });
    expect(html).toContain('data-role="member"');
    expect(html).toContain('member:false');
    expect(html).toContain('Support read access');
    expect(html).not.toContain('data-role="owner"');
  });

  it('retains legacy staff owner elevation when support access is disabled', async () => {
    mockSupportEnabled.mockReturnValue(false);
    mockAuth.mockResolvedValue({
      success: true,
      data: {
        user: { role: 'member', is_admin: true },
        organization,
        access: { kind: 'legacy_admin', role: 'owner' },
      },
    } as Awaited<ReturnType<typeof getAuthorizedOrgContext>>);
    const render = jest.fn(({ role, isGlobalAdmin }: PageRenderProps) =>
      React.createElement('div', null, `${role}:${isGlobalAdmin}`)
    );

    const html = renderToStaticMarkup(await OrganizationByPageLayout({ params, render }));

    expect(render).toHaveBeenCalledWith({ role: 'owner', organization, isGlobalAdmin: true });
    expect(html).toContain('data-role="owner"');
    expect(html).toContain('owner:true');
    expect(html).not.toContain('Support read access');
  });
});
