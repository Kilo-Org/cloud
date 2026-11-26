jest.mock('@/lib/organizations/organization-auth', () => ({
  getAuthorizedOrgContext: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  signInUrlWithCallbackPath: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
jest.mock('@/lib/admin/require-admin-page', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  return {
    AdminStepUpGate: ({ requirement }: { requirement: { code: string } }) =>
      ReactActual.createElement('div', { 'data-step-up': requirement.code }),
  };
});
jest.mock('./CloudChatPageWrapperNext', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  return {
    CloudChatPageWrapperNext: ({ organizationRole }: { organizationRole: string }) =>
      ReactActual.createElement('main', { 'data-role': organizationRole }),
  };
});
jest.mock('@/components/cloud-agent-next/LegacySessionViewer', () => ({
  LegacySessionViewer: () => null,
}));
jest.mock('@/components/cloud-agent-next/server/PrefetchedCloudChat', () => ({
  PrefetchedCloudChat: ({ children }: { children: unknown }) => children,
}));
jest.mock('@/components/cloud-agent-next/server/read-known-models', () => ({
  readKnownModels: jest.fn(async () => []),
}));
jest.mock('@/components/cloud-agent-next/server/redirect-to-session-scope', () => ({
  redirectToSessionScope: jest.fn(),
}));

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import { NextResponse } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Organization } from '@kilocode/db/schema';
import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import type * as OrganizationAuth from '@/lib/organizations/organization-auth';
import type * as UserServer from '@kilocode/web-shared/lib/user/server';
import type * as NextNavigation from 'next/navigation';
import OrganizationCloudChatPage from './page';

type AuthResult = Awaited<ReturnType<typeof OrganizationAuth.getAuthorizedOrgContext>>;

const previousReact = Reflect.get(globalThis, 'React');
const { getAuthorizedOrgContext } = jest.requireMock<typeof OrganizationAuth>(
  '@/lib/organizations/organization-auth'
);
const { signInUrlWithCallbackPath } = jest.requireMock<typeof UserServer>(
  '@kilocode/web-shared/lib/user/server'
);
const { redirect } = jest.requireMock<typeof NextNavigation>('next/navigation');
const mockAuth = jest.mocked(getAuthorizedOrgContext);
const mockSignInUrl = jest.mocked(signInUrlWithCallbackPath);
const mockRedirect = jest.mocked(redirect);

beforeAll(() => {
  Reflect.set(globalThis, 'React', React);
});

afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Reflect.set(globalThis, 'React', previousReact);
});

function render(organizationId: string) {
  return OrganizationCloudChatPage({
    params: Promise.resolve({ id: organizationId }),
    searchParams: Promise.resolve({}),
  });
}

function refusal(status: number, error: string): Extract<AuthResult, { success: false }> {
  return { success: false, nextResponse: NextResponse.json({ error }, { status }) };
}

describe('OrganizationCloudChatPage', () => {
  let organization: Organization;

  beforeEach(async () => {
    mockAuth.mockReset();
    mockRedirect.mockClear();
    mockSignInUrl.mockReset();
    const owner = await insertTestUser();
    organization = await createTestOrganization('Chat org', owner.id, 0);
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  it('renders the chat for a member with the granted role', async () => {
    const member = await insertTestUser();
    mockAuth.mockResolvedValue({
      success: true,
      data: {
        user: { ...member, role: 'member' },
        organization,
        access: { kind: 'member', role: 'member' },
      },
    });

    const html = renderToStaticMarkup(await render(organization.id));

    expect(html).toContain('data-role="member"');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('renders the step-up gate in place when the staff guard needs a proof', async () => {
    mockAuth.mockResolvedValue({
      ...refusal(403, 'MFA_REQUIRED'),
      stepUp: {
        code: 'MFA_REQUIRED',
        actionClass: 'support_read',
        purpose: 'session',
        maxAgeSeconds: 1800,
      },
    });

    const html = renderToStaticMarkup(await render(organization.id));

    expect(html).toBe('<div data-step-up="MFA_REQUIRED"></div>');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('renders the admin network refusal for staff off the corporate network', async () => {
    mockAuth.mockResolvedValue({
      ...refusal(403, 'Admin access is limited to the corporate network'),
      adminNetworkDenial: 'outside-allowlist',
    });

    const html = renderToStaticMarkup(await render(organization.id));

    expect(html).toContain('Access Denied');
    expect(html).toContain('limited to the corporate network');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('keeps the profile redirect for a refusal without a step-up requirement', async () => {
    mockAuth.mockResolvedValue(refusal(404, 'Organization not found'));

    await expect(render(organization.id)).rejects.toThrow('redirect:/profile');
  });

  it('keeps the sign-in redirect for an unauthenticated request', async () => {
    mockSignInUrl.mockResolvedValue('/users/sign_in');
    mockAuth.mockResolvedValue(refusal(401, 'Unauthorized'));

    await expect(render(organization.id)).rejects.toThrow('redirect:/users/sign_in');
  });
});
