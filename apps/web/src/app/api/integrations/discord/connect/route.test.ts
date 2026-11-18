import { beforeEach, describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { getDiscordOAuthUrl } from '@/lib/integrations/discord-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { beginProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/integrations/discord-service', () => ({
  getDiscordOAuthUrl: jest.fn(),
}));
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  beginProviderOAuthAttempt: jest.fn(async () => undefined),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockedGetDiscordOAuthUrl = jest.mocked(getDiscordOAuthUrl);
const mockedBeginProviderOAuthAttempt = jest.mocked(beginProviderOAuthAttempt);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORGANIZATION_ID = '9a1f56f0-6a52-4c1f-9f5d-0b0f7f2e6ad4';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

async function callDiscordConnect(request: NextRequest) {
  const { GET } = await import('../../[platform]/connect/route');
  return GET(request, { params: Promise.resolve({ platform: 'discord' }) });
}

function redirectUrl(response: Response) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  return new URL(location ?? '');
}

describe('GET /api/integrations/discord/connect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedEnsureOrganizationAccess.mockResolvedValue('billing_manager');
    mockedGetDiscordOAuthUrl.mockReturnValue(
      'https://discord.com/oauth2/authorize?client_id=test&state=signed'
    );
  });

  test('mints an organization state for a caller with the organization integration role', async () => {
    await callDiscordConnect(
      makeRequest(`/api/integrations/discord/connect?organizationId=${ORGANIZATION_ID}`)
    );

    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: expect.objectContaining({ id: USER_ID }) },
      ORGANIZATION_ID,
      ORGANIZATION_BILLING_ROLES
    );
    const state = mockedGetDiscordOAuthUrl.mock.calls[0]?.[0];
    expect(verifyOAuthState(state ?? null)).toEqual(
      expect.objectContaining({
        owner: `org_${ORGANIZATION_ID}`,
        userId: USER_ID,
        provider: 'discord',
        purpose: 'provider_install',
      })
    );
    expect(mockedBeginProviderOAuthAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        owner: { type: 'org', id: ORGANIZATION_ID },
        provider: 'discord',
      })
    );
  });

  test('refuses an organization state for a member without the integration role', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      })
    );

    const response = await callDiscordConnect(
      makeRequest(`/api/integrations/discord/connect?organizationId=${ORGANIZATION_ID}`)
    );

    expect(`${redirectUrl(response).pathname}${redirectUrl(response).search}`).toBe(
      `/organizations/${ORGANIZATION_ID}/integrations/discord?error=permission_required`
    );
    expect(mockedGetDiscordOAuthUrl).not.toHaveBeenCalled();
    expect(mockedBeginProviderOAuthAttempt).not.toHaveBeenCalled();
  });

  test('keeps a personal connection free of an organization role check', async () => {
    await callDiscordConnect(makeRequest('/api/integrations/discord/connect'));

    expect(mockedEnsureOrganizationAccess).not.toHaveBeenCalled();
    const state = mockedGetDiscordOAuthUrl.mock.calls[0]?.[0];
    expect(verifyOAuthState(state ?? null)).toEqual(
      expect.objectContaining({ owner: `user_${USER_ID}`, userId: USER_ID })
    );
  });
});
