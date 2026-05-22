import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { createGitLabBotLinkState } from '@/lib/bot/gitlab-link-state';
import { verifyGitLabLinkToken } from '@/lib/bot/gitlab-link-token';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegrationById,
} from '@/lib/bot/platform-helpers';
import { buildGitLabOAuthUrl } from '@/lib/integrations/platforms/gitlab/adapter';
import { getUserFromAuth } from '@/lib/user.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { failureResult } from '@/lib/maybe-result';

const mockIsEnabledForBot = jest.fn();

jest.mock('@/lib/user.server');
jest.mock('@/lib/bot/gitlab-link-state');
jest.mock('@/lib/bot/gitlab-link-token');
jest.mock('@/lib/bot/platform-helpers');
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  buildGitLabOAuthUrl: jest.fn(),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({ isEnabledForBot: mockIsEnabledForBot })),
  },
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCreateGitLabBotLinkState = jest.mocked(createGitLabBotLinkState);
const mockedVerifyGitLabLinkToken = jest.mocked(verifyGitLabLinkToken);
const mockedGetPlatformIntegrationById = jest.mocked(getPlatformIntegrationById);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);
const mockedBuildGitLabOAuthUrl = jest.mocked(buildGitLabOAuthUrl);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const PLATFORM_INTEGRATION_ID = 'pi_gitlab_1';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

describe('GET /gitlab/link', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitLabLinkToken.mockReturnValue({
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      integrationId: PLATFORM_INTEGRATION_ID,
    });
    mockedCreateGitLabBotLinkState.mockReturnValue('signed-state');
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: PLATFORM_INTEGRATION_ID,
      platform: PLATFORM.GITLAB,
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      metadata: { bot_enabled: true, gitlab_instance_url: 'https://gitlab.example.com' },
    } as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);
    mockIsEnabledForBot.mockReturnValue(true);
    mockedBuildGitLabOAuthUrl.mockReturnValue(
      'https://gitlab.example.com/oauth/authorize?scope=read_user&state=signed-state'
    );
  });

  test('rejects tampered or expired tokens', async () => {
    mockedVerifyGitLabLinkToken.mockReturnValue(null);
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/gitlab/link?token=bogus'));

    expect(response.status).toBe(400);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
  });

  test('redirects unauthenticated users to sign-in preserving the signed token', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/gitlab/link?token=signed-token'));
    const location = response.headers.get('location');

    expect(response.status).toBe(307);
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(url.pathname).toBe('/users/sign_in');
    expect(url.searchParams.get('callbackPath')).toBe('/gitlab/link?token=signed-token');
  });

  test('returns 404 when the integration does not match the signed token', async () => {
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: 'other',
      platform: PLATFORM.GITLAB,
      metadata: { bot_enabled: true },
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/gitlab/link?token=signed-token'));

    expect(response.status).toBe(404);
    expect(mockedCreateGitLabBotLinkState).not.toHaveBeenCalled();
  });

  test('returns 404 when bot linking is disabled', async () => {
    mockIsEnabledForBot.mockReturnValue(false);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/gitlab/link?token=signed-token'));

    expect(response.status).toBe(404);
    expect(mockedCreateGitLabBotLinkState).not.toHaveBeenCalled();
  });

  test('returns 403 when the Kilo user cannot access the integration owner', async () => {
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/gitlab/link?token=signed-token'));

    expect(response.status).toBe(403);
    expect(mockedCreateGitLabBotLinkState).not.toHaveBeenCalled();
  });

  test('redirects to GitLab OAuth with read_user scope on the happy path', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/gitlab/link?token=signed-token'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://gitlab.example.com/oauth/authorize?scope=read_user&state=signed-state'
    );
    expect(mockedCreateGitLabBotLinkState).toHaveBeenCalledWith({
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
    });
    expect(mockedBuildGitLabOAuthUrl).toHaveBeenCalledWith(
      'signed-state',
      'https://gitlab.example.com',
      undefined,
      ['read_user']
    );
  });
});
