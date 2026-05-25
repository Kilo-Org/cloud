import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { createLinearBotLinkState } from '@/lib/bot/linear-link-state';
import { verifyLinearLinkToken } from '@/lib/bot/linear-link-token';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegrationById,
} from '@/lib/bot/platform-helpers';
import { getLinearUserOAuthUrl } from '@/lib/integrations/linear-service';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { failureResult } from '@/lib/maybe-result';

const mockIsEnabledForBot = jest.fn();

jest.mock('@/lib/user/server');
jest.mock('@/lib/bot/linear-link-state');
jest.mock('@/lib/bot/linear-link-token');
jest.mock('@/lib/bot/platform-helpers');
jest.mock('@/lib/integrations/linear-service', () => ({
  getLinearUserOAuthUrl: jest.fn(),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({ isEnabledForBot: mockIsEnabledForBot })),
  },
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCreateLinearBotLinkState = jest.mocked(createLinearBotLinkState);
const mockedVerifyLinearLinkToken = jest.mocked(verifyLinearLinkToken);
const mockedGetPlatformIntegrationById = jest.mocked(getPlatformIntegrationById);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);
const mockedGetLinearUserOAuthUrl = jest.mocked(getLinearUserOAuthUrl);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const PLATFORM_INTEGRATION_ID = 'pi_linear_1';
const ORGANIZATION_ID = 'org-linear-123';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function expectRedirectLocation(response: Response, expected: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  expect(location).toBe(expected);
}

describe('GET /linear/link', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedVerifyLinearLinkToken.mockReturnValue({
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
    });
    mockedCreateLinearBotLinkState.mockReturnValue('signed-state');
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: PLATFORM_INTEGRATION_ID,
      platform: PLATFORM.LINEAR,
      platform_installation_id: ORGANIZATION_ID,
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      metadata: { bot_enabled: true },
    } as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);
    mockIsEnabledForBot.mockReturnValue(true);
    mockedGetLinearUserOAuthUrl.mockReturnValue(
      'https://linear.app/oauth/authorize?actor=user&scope=read&state=signed-state'
    );
  });

  test('rejects requests without a token', async () => {
    mockedVerifyLinearLinkToken.mockReturnValue(null);
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link'));

    expect(response.status).toBe(400);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedCreateLinearBotLinkState).not.toHaveBeenCalled();
  });

  test('rejects tampered or expired tokens', async () => {
    mockedVerifyLinearLinkToken.mockReturnValue(null);
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link?token=bogus'));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Link Expired');
  });

  test('redirects unauthenticated users to sign-in preserving the signed token', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link?token=signed-token'));

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(url.pathname).toBe('/users/sign_in');
    expect(url.searchParams.get('callbackPath')).toBe('/linear/link?token=signed-token');
  });

  test('returns 404 when the integration has been removed since the token was issued', async () => {
    mockedGetPlatformIntegrationById.mockRejectedValue(
      new Error('Could not find platform integration pi_linear_1')
    );

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link?token=signed-token'));

    expect(response.status).toBe(404);
    expect(mockedCreateLinearBotLinkState).not.toHaveBeenCalled();
    expect(mockedGetLinearUserOAuthUrl).not.toHaveBeenCalled();
  });

  test('returns 404 when the integration is not for the linear platform', async () => {
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: PLATFORM_INTEGRATION_ID,
      platform: PLATFORM.SLACK,
      platform_installation_id: ORGANIZATION_ID,
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      metadata: { bot_enabled: true },
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link?token=signed-token'));

    expect(response.status).toBe(404);
    expect(mockedCreateLinearBotLinkState).not.toHaveBeenCalled();
  });

  test('returns 404 when the integration platform_installation_id does not match the token', async () => {
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: PLATFORM_INTEGRATION_ID,
      platform: PLATFORM.LINEAR,
      platform_installation_id: 'other-org',
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      metadata: { bot_enabled: true },
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link?token=signed-token'));

    expect(response.status).toBe(404);
    expect(mockedCreateLinearBotLinkState).not.toHaveBeenCalled();
  });

  test('returns 404 when bot is not enabled for the integration', async () => {
    mockIsEnabledForBot.mockReturnValue(false);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link?token=signed-token'));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain(
      'Linear linking is not enabled for this integration'
    );
    expect(mockedCreateLinearBotLinkState).not.toHaveBeenCalled();
  });

  test('returns 403 when the Kilo user cannot access the integration owner', async () => {
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link?token=signed-token'));

    expect(response.status).toBe(403);
    expect(mockedCreateLinearBotLinkState).not.toHaveBeenCalled();
  });

  test('redirects to Linear OAuth with the signed state on the happy path', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/linear/link?token=signed-token'));

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      'https://linear.app/oauth/authorize?actor=user&scope=read&state=signed-state'
    );
    expect(mockedCreateLinearBotLinkState).toHaveBeenCalledWith({
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
    });
    expect(mockedGetLinearUserOAuthUrl).toHaveBeenCalledWith('signed-state');
  });
});
