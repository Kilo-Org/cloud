import { beforeEach, describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { NextRequest } from 'next/server';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getDoltHubOAuthUrl } from '@/lib/integrations/dolthub-service';
import { handlePlatformOAuthConnect } from '@/lib/integrations/oauth/routes';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/integrations/dolthub-service', () => ({
  getDoltHubOAuthUrl: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockedGetDoltHubOAuthUrl = jest.mocked(getDoltHubOAuthUrl);

const USER_ID = 'e0c2bd2a-4d1e-4c33-9a2f-6f0f2f3a5b11';
const ORGANIZATION_ID = 'org-fixture-for-connect-route-test';
const AUTHORIZE_URL = 'https://www.dolthub.com/oauth/authorize?client_id=client';

function connectRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/integrations/dolthub/connect${query}`);
}

function redirectPath(response: Response): string {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  return `${url.pathname}${url.search}`;
}

describe('DoltHub OAuth connect route owner authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedEnsureOrganizationAccess.mockResolvedValue('owner');
    mockedGetDoltHubOAuthUrl.mockReturnValue(AUTHORIZE_URL);
  });

  test('an organization connect checks the billing role that governs integrations', async () => {
    const response = await handlePlatformOAuthConnect(
      connectRequest(`?organizationId=${ORGANIZATION_ID}`),
      'dolthub'
    );

    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: USER_ID }) }),
      ORGANIZATION_ID,
      ORGANIZATION_BILLING_ROLES
    );
    expect(response.headers.get('location')).toContain(AUTHORIZE_URL);
  });

  test('a rejected organization role redirects back to the integration page with the reason', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValueOnce(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      })
    );

    const response = await handlePlatformOAuthConnect(
      connectRequest(`?organizationId=${ORGANIZATION_ID}`),
      'dolthub'
    );

    expect(redirectPath(response)).toBe(
      `/organizations/${ORGANIZATION_ID}/integrations/dolthub?error=permission_required`
    );
  });

  test('a personal connect never consults organization roles', async () => {
    const response = await handlePlatformOAuthConnect(connectRequest(), 'dolthub');

    expect(mockedEnsureOrganizationAccess).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toContain(AUTHORIZE_URL);
  });
});
