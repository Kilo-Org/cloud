import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { createGitHubBotLinkState, verifyGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { verifyGitHubLinkToken } from '@/lib/bot/github-link-token';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';
import { getPlatformIntegrationById } from '@/lib/bot/platform-helpers';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { failureResult } from '@/lib/maybe-result';

const mockIsEnabledForBot = jest.fn();

jest.mock('@/lib/user.server');
jest.mock('@/lib/bot/github-link-state');
jest.mock('@/lib/bot/github-link-token');
jest.mock('@/lib/integrations/platforms/github/app-selector');
jest.mock('@/lib/bot/platform-helpers');
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({ isEnabledForBot: mockIsEnabledForBot })),
  },
}));
jest.mock('@/lib/organizations/organizations');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCreateGitHubBotLinkState = jest.mocked(createGitHubBotLinkState);
const mockedVerifyGitHubBotLinkState = jest.mocked(verifyGitHubBotLinkState);
const mockedVerifyGitHubLinkToken = jest.mocked(verifyGitHubLinkToken);
const mockedGetGitHubAppCredentials = jest.mocked(getGitHubAppCredentials);
const mockedGetPlatformIntegrationById = jest.mocked(getPlatformIntegrationById);
const mockedIsOrganizationMember = jest.mocked(isOrganizationMember);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const OTHER_USER_ID = 'c00b91a1-6959-4b04-9ef8-e8d37b340f4a';
const INSTALLATION_ID = '98765';
const PLATFORM_INTEGRATION_ID = 'pi_github_1';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('GET /github/link', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubLinkToken.mockReturnValue({
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      installationId: INSTALLATION_ID,
    });
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);
    mockedCreateGitHubBotLinkState.mockReturnValue('signed-state');
    mockedGetGitHubAppCredentials.mockReturnValue({
      appId: 'app-id',
      privateKey: 'private-key',
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      appName: 'KiloConnect',
      webhookSecret: 'webhook-secret',
    });
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: PLATFORM_INTEGRATION_ID,
      github_app_type: 'standard',
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      platform_installation_id: INSTALLATION_ID,
    } as never);
    mockIsEnabledForBot.mockReturnValue(true);
    mockedIsOrganizationMember.mockResolvedValue(true);
  });

  test('rejects requests without a token', async () => {
    mockedVerifyGitHubLinkToken.mockReturnValue(null);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link') as never);

    expect(response.status).toBe(400);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedCreateGitHubBotLinkState).not.toHaveBeenCalled();
  });

  test('rejects tampered or expired tokens', async () => {
    mockedVerifyGitHubLinkToken.mockReturnValue(null);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link?token=bogus') as never);

    expect(response.status).toBe(400);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedCreateGitHubBotLinkState).not.toHaveBeenCalled();
  });

  test('redirects unauthenticated users to sign-in preserving the signed token', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link?token=signed-token') as never);

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      '/users/sign_in?callbackPath=%2Fgithub%2Flink%3Ftoken%3Dsigned-token'
    );
  });

  test('redirects authenticated users to GitHub OAuth with signed state', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link?token=signed-token') as never);

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location ?? '');

    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      'https://github.com/login/oauth/authorize'
    );
    expect(redirectUrl.searchParams.get('client_id')).toBe('github-client-id');
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/integrations/github/callback'
    );
    expect(redirectUrl.searchParams.get('state')).toBe('signed-state');
    expect(redirectUrl.searchParams.get('scope')).toBe('read:user');
    expect(mockedGetPlatformIntegrationById).toHaveBeenCalledWith(PLATFORM_INTEGRATION_ID);
    expect(mockedCreateGitHubBotLinkState).toHaveBeenCalledWith(USER_ID, INSTALLATION_ID);
    expect(mockedGetGitHubAppCredentials).toHaveBeenCalledWith('standard');
  });

  test("picks credentials matching the integration's github_app_type", async () => {
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: PLATFORM_INTEGRATION_ID,
      github_app_type: 'lite',
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      platform_installation_id: INSTALLATION_ID,
    } as never);

    const { GET } = await import('./route');
    await GET(makeRequest('/github/link?token=signed-token') as never);

    expect(mockedGetGitHubAppCredentials).toHaveBeenCalledWith('lite');
  });

  test('returns 404 when the integration has been removed since the token was issued', async () => {
    mockedGetPlatformIntegrationById.mockRejectedValue(
      new Error('Could not find platform integration pi_github_1')
    );

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link?token=signed-token') as never);

    expect(response.status).toBe(404);
    expect(mockedCreateGitHubBotLinkState).not.toHaveBeenCalled();
    expect(mockedGetGitHubAppCredentials).not.toHaveBeenCalled();
  });

  test('rejects users who are not members of the owning organization', async () => {
    mockedIsOrganizationMember.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link?token=signed-token') as never);

    expect(response.status).toBe(403);
    expect(mockedCreateGitHubBotLinkState).not.toHaveBeenCalled();
  });

  test('rejects integrations without bot_enabled metadata before redirecting to GitHub', async () => {
    mockIsEnabledForBot.mockReturnValue(false);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link?token=signed-token') as never);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain(
      'GitHub linking is not enabled for this integration'
    );
    expect(mockedCreateGitHubBotLinkState).not.toHaveBeenCalled();
    expect(mockedGetGitHubAppCredentials).not.toHaveBeenCalled();
  });

  test('rejects users who do not own a user-owned integration', async () => {
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: PLATFORM_INTEGRATION_ID,
      github_app_type: 'standard',
      owned_by_organization_id: null,
      owned_by_user_id: OTHER_USER_ID,
      platform_installation_id: INSTALLATION_ID,
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link?token=signed-token') as never);

    expect(response.status).toBe(403);
    expect(mockedCreateGitHubBotLinkState).not.toHaveBeenCalled();
  });
});
