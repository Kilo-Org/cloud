import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { verifyOAuthState, createOAuthState } from '@/lib/integrations/oauth-state';
import { bot } from '@/lib/bot';
import {
  exchangeLinearOAuthCode,
  fetchLinearOAuthIdentity,
  LinearWorkspaceAlreadyConnectedError,
  revokeLinearToken,
  upsertLinearInstallation,
} from '@/lib/integrations/linear-service';
import { linkKiloUser, unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { verifyLinearBotLinkState } from '@/lib/bot/linear-link-state';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegrationById,
} from '@/lib/bot/platform-helpers';
import { PLATFORM } from '@/lib/integrations/core/constants';

const mockIsEnabledForBot = jest.fn();
const mockLinearOrganization = jest.fn(async () => ({ name: 'Acme Workspace', urlKey: 'acme' }));

jest.mock('@linear/sdk', () => ({
  LinearClient: jest.fn().mockImplementation(() => ({
    get organization() {
      return mockLinearOrganization();
    },
  })),
}));
jest.mock('@/lib/user/server');
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getAdapter: jest.fn(),
    getState: jest.fn(() => ({ kind: 'state' })),
  },
}));
jest.mock('@/lib/integrations/linear-service', () => {
  const actual = jest.requireActual('@/lib/integrations/linear-service');
  return {
    ...actual,
    upsertLinearInstallation: jest.fn(),
    exchangeLinearOAuthCode: jest.fn(),
    fetchLinearOAuthIdentity: jest.fn(),
    revokeLinearToken: jest.fn(async () => true),
  };
});
jest.mock('@/lib/bot-identity', () => ({
  linkKiloUser: jest.fn(async () => undefined),
  unlinkTeamKiloUsers: jest.fn(async () => 0),
}));
jest.mock('@/lib/bot/linear-link-state', () => ({
  verifyLinearBotLinkState: jest.fn(() => null),
}));
jest.mock('@/lib/bot/platform-helpers', () => ({
  getPlatformIntegrationById: jest.fn(),
  canKiloUserAccessPlatformIntegration: jest.fn(),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({ isEnabledForBot: mockIsEnabledForBot })),
  },
}));
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedBotGetAdapter = jest.mocked(bot.getAdapter);
const mockedUpsertLinearInstallation = jest.mocked(upsertLinearInstallation);
const mockedUnlinkTeamKiloUsers = jest.mocked(unlinkTeamKiloUsers);
const mockedExchangeLinearOAuthCode = jest.mocked(exchangeLinearOAuthCode);
const mockedFetchLinearOAuthIdentity = jest.mocked(fetchLinearOAuthIdentity);
const mockedRevokeLinearToken = jest.mocked(revokeLinearToken);
const mockedLinkKiloUser = jest.mocked(linkKiloUser);
const mockedVerifyLinearBotLinkState = jest.mocked(verifyLinearBotLinkState);
const mockedGetPlatformIntegrationById = jest.mocked(getPlatformIntegrationById);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const OTHER_USER_ID = 'c00b91a1-6959-4b04-9ef8-e8d37b340f4a';
const ORGANIZATION_ID = 'org-linear-123';
const PLATFORM_INTEGRATION_ID = 'pi_linear_1';
// Different from the comment author's id, to prove the OAuth-derived id wins.
const COMMENT_AUTHOR_LINEAR_ID = 'linear-user-A';
const OAUTH_VIEWER_LINEAR_ID = 'linear-user-B';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

async function callLinearCallback(request: NextRequest) {
  const { GET } = await import('../../[platform]/callback/route');
  return GET(request, { params: Promise.resolve({ platform: 'linear' }) });
}

describe('GET /api/integrations/linear/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Install-flow tests must take the install branch, not the bot-link
    // branch — explicitly null out the bot-link state so the dispatcher
    // falls through.
    mockedVerifyLinearBotLinkState.mockReturnValue(null);

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);

    mockedBotGetAdapter.mockReturnValue({
      handleOAuthCallback: jest.fn(async () => ({
        organizationId: ORGANIZATION_ID,
        installation: {
          accessToken: 'tok',
          botUserId: 'bot-1',
          organizationId: ORGANIZATION_ID,
          expiresAt: null,
        },
      })),
      deleteInstallation: jest.fn(async () => undefined),
    } as never);

    mockLinearOrganization.mockResolvedValue({ name: 'Acme Workspace', urlKey: 'acme' });
  });

  test('redirects to sign-in when user is unauthenticated', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await callLinearCallback(makeRequest('/api/integrations/linear/callback'));

    expect(response.headers.get('location')).toContain('/users/sign_in');
  });

  test('redirects with the oauth error when Linear returns one', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);
    const response = await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?error=access_denied&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/linear?error=access_denied');
  });

  test('redirects oauth errors to returnTo when signed state carries one', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, '/claw/new?step=linear');
    const response = await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?error=access_denied&state=${state}`)
    );

    expectRedirectLocation(response, '/claw/new?step=linear&error=access_denied');
  });

  test('encodes oauth error values before redirecting', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);
    const response = await callLinearCallback(
      makeRequest(
        `/api/integrations/linear/callback?error=${encodeURIComponent(
          'access_denied&success=installed'
        )}&state=${state}`
      )
    );

    expectRedirectLocation(
      response,
      '/integrations/linear?error=access_denied%26success%3Dinstalled'
    );
  });

  test('redirects with missing_code when no code is present', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);
    const response = await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/linear?error=missing_code');
  });

  test('rejects an invalid state signature', async () => {
    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=forged.sig')
    );

    expectRedirectLocation(response, '/integrations?error=invalid_state');
  });

  test('rejects when the state was signed for a different user', async () => {
    const state = createOAuthState(`user_${OTHER_USER_ID}`, OTHER_USER_ID);
    const response = await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations?error=unauthorized');
  });

  test('invokes upsertLinearInstallation with the workspace name from Linear GraphQL', async () => {
    mockedUpsertLinearInstallation.mockResolvedValue({} as never);
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);
    const response = await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?code=abc&state=${state}`)
    );

    expect(mockedUpsertLinearInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { type: 'user', id: USER_ID },
        organizationId: ORGANIZATION_ID,
        organizationName: 'Acme Workspace',
      }),
      expect.objectContaining({
        getChatSdkAccessToken: expect.any(Function),
        deleteChatSdkInstallation: expect.any(Function),
        deleteChatSdkIdentityCache: expect.any(Function),
      })
    );
    expectRedirectLocation(response, '/integrations/linear?success=installed');
  });

  test('redirects successful installs to returnTo when signed state carries one', async () => {
    mockedUpsertLinearInstallation.mockResolvedValue({} as never);
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, '/claw/new?step=linear');
    const response = await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/claw/new?step=linear&success=linear_installed');
  });

  test('inserts returnTo success query before a fragment', async () => {
    mockedUpsertLinearInstallation.mockResolvedValue({} as never);
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, '/claw/new#calendar');
    const response = await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?code=abc&state=${state}`)
    );

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(`${url.pathname}${url.search}${url.hash}`).toBe(
      '/claw/new?success=linear_installed#calendar'
    );
  });

  test('falls back to organizationId when the Linear GraphQL query fails', async () => {
    mockLinearOrganization.mockRejectedValue(new Error('Unauthorized'));
    mockedUpsertLinearInstallation.mockResolvedValue({} as never);
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);
    await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?code=abc&state=${state}`)
    );

    expect(mockedUpsertLinearInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationName: ORGANIZATION_ID,
      }),
      expect.anything()
    );
  });

  test('rolls back the Chat SDK installation when the workspace is already connected', async () => {
    mockedUpsertLinearInstallation.mockRejectedValue(
      new LinearWorkspaceAlreadyConnectedError('Acme')
    );
    const deleteInstallation = jest.fn<Promise<void>, [string]>(async () => undefined);
    const adapter = {
      handleOAuthCallback: jest.fn(async () => ({
        organizationId: ORGANIZATION_ID,
        installation: {
          accessToken: 'tok',
          botUserId: 'bot-1',
          organizationId: ORGANIZATION_ID,
          expiresAt: null,
        },
      })),
      withInstallation: jest.fn(async <T>(_orgId: unknown, fn: () => Promise<T> | T) => fn()),
      getUser: jest.fn(async () => ({ fullName: 'Acme', userName: 'acme' })),
      deleteInstallation,
    };
    mockedBotGetAdapter.mockReturnValue(adapter as never);

    const state = createOAuthState(`user_${USER_ID}`, USER_ID);
    const response = await callLinearCallback(
      makeRequest(`/api/integrations/linear/callback?code=abc&state=${state}`)
    );

    expect(deleteInstallation).toHaveBeenCalledTimes(1);
    expect(deleteInstallation).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(mockedUnlinkTeamKiloUsers).toHaveBeenCalledTimes(1);
    expect(mockedUnlinkTeamKiloUsers).toHaveBeenCalledWith(
      expect.anything(),
      'linear',
      ORGANIZATION_ID
    );
    expectRedirectLocation(response, '/integrations/linear?error=workspace_already_connected');
  });
});

describe('verifyOAuthState (self-check, to keep tests honest)', () => {
  test('rejects a tampered signature', () => {
    expect(verifyOAuthState('payload.badsig')).toBeNull();
  });

  test('round-trips a safe return path', () => {
    const state = createOAuthState(
      `user_${USER_ID}`,
      USER_ID,
      '/collab/authorize?services=linear&step=0'
    );

    expect(verifyOAuthState(state)).toMatchObject({
      owner: `user_${USER_ID}`,
      returnTo: '/collab/authorize?services=linear&step=0',
      userId: USER_ID,
    });
  });
});

describe('GET /api/integrations/linear/callback bot-link flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);

    // The default install-flow adapter must NOT be invoked when the bot-link
    // state matches; tests assert this.
    mockedBotGetAdapter.mockReturnValue({
      handleOAuthCallback: jest.fn(async () => {
        throw new Error('handleOAuthCallback should not be called for bot-link');
      }),
      deleteInstallation: jest.fn(async () => undefined),
    } as never);

    mockedVerifyLinearBotLinkState.mockReturnValue({
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
      callbackPath: '/linear/link',
    });
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
    mockedExchangeLinearOAuthCode.mockResolvedValue({
      accessToken: 'lin_user_tok',
      refreshToken: null,
      expiresIn: 3600,
      scope: 'read',
    });
    mockedFetchLinearOAuthIdentity.mockResolvedValue({
      viewerId: OAUTH_VIEWER_LINEAR_ID,
      viewerName: 'Linear User B',
      organizationId: ORGANIZATION_ID,
      organizationName: 'Acme Workspace',
    });
    mockedRevokeLinearToken.mockResolvedValue(true);
  });

  test('rejects when state.userId does not match the session user', async () => {
    mockedVerifyLinearBotLinkState.mockReturnValue({
      userId: OTHER_USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
      callbackPath: '/linear/link',
    });

    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(response.status).toBe(403);
    expect(mockedExchangeLinearOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects when the OAuth viewer belongs to a different Linear workspace, and revokes the proof token', async () => {
    mockedFetchLinearOAuthIdentity.mockResolvedValue({
      viewerId: OAUTH_VIEWER_LINEAR_ID,
      viewerName: 'Linear User B',
      organizationId: 'some-other-org',
      organizationName: 'Another Workspace',
    });

    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(response.status).toBe(403);
    expect(mockedRevokeLinearToken).toHaveBeenCalledWith('lin_user_tok', 'access_token');
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('returns 403 when the Kilo user cannot access the integration owner', async () => {
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(response.status).toBe(403);
    expect(mockedExchangeLinearOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('returns 404 when the integration cannot be found', async () => {
    mockedGetPlatformIntegrationById.mockRejectedValue(new Error('not found'));

    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(response.status).toBe(404);
    expect(mockedExchangeLinearOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('returns 404 when the integration platform_installation_id does not match the state', async () => {
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: PLATFORM_INTEGRATION_ID,
      platform: PLATFORM.LINEAR,
      platform_installation_id: 'a-different-org',
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      metadata: { bot_enabled: true },
    } as never);

    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(response.status).toBe(404);
    expect(mockedExchangeLinearOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('returns 404 when bot is not enabled for the integration', async () => {
    mockIsEnabledForBot.mockReturnValue(false);

    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(response.status).toBe(404);
    expect(mockedExchangeLinearOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('renders an error page when Linear returns an OAuth error', async () => {
    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?error=access_denied&state=signed-bot-link')
    );

    expect(response.status).toBe(400);
    expect(mockedExchangeLinearOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('happy path: links the OAuth-verified Linear viewer id, NOT the comment author id', async () => {
    const response = await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('Linear account linked');

    expect(mockedExchangeLinearOAuthCode).toHaveBeenCalledWith('abc');
    expect(mockedFetchLinearOAuthIdentity).toHaveBeenCalledWith('lin_user_tok');

    expect(mockedLinkKiloUser).toHaveBeenCalledTimes(1);
    expect(mockedLinkKiloUser).toHaveBeenCalledWith(
      expect.anything(),
      {
        platform: PLATFORM.LINEAR,
        teamId: ORGANIZATION_ID,
        userId: OAUTH_VIEWER_LINEAR_ID,
      },
      USER_ID
    );

    // The comment author's Linear user id must never reach linkKiloUser.
    expect(mockedLinkKiloUser).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: COMMENT_AUTHOR_LINEAR_ID }),
      expect.anything()
    );

    expect(mockedRevokeLinearToken).toHaveBeenCalledWith('lin_user_tok', 'access_token');
  });

  test('also revokes the refresh token if Linear returned one', async () => {
    mockedExchangeLinearOAuthCode.mockResolvedValue({
      accessToken: 'lin_user_tok',
      refreshToken: 'lin_refresh_tok',
      expiresIn: 3600,
      scope: 'read',
    });

    await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(mockedRevokeLinearToken).toHaveBeenCalledWith('lin_user_tok', 'access_token');
    expect(mockedRevokeLinearToken).toHaveBeenCalledWith('lin_refresh_tok', 'refresh_token');
  });

  test('revokes proof tokens even when linkKiloUser throws', async () => {
    mockedExchangeLinearOAuthCode.mockResolvedValue({
      accessToken: 'lin_user_tok',
      refreshToken: 'lin_refresh_tok',
      expiresIn: 3600,
      scope: 'read',
    });
    mockedLinkKiloUser.mockRejectedValueOnce(new Error('db down'));

    // The outer GET handler catches thrown errors and turns them into a
    // redirect, so we don't observe the throw here — we only care that the
    // `finally` in the bot-link handler dropped the proof tokens.
    await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(mockedLinkKiloUser).toHaveBeenCalledTimes(1);
    expect(mockedRevokeLinearToken).toHaveBeenCalledWith('lin_user_tok', 'access_token');
    expect(mockedRevokeLinearToken).toHaveBeenCalledWith('lin_refresh_tok', 'refresh_token');
  });

  test('does not invoke the workspace install flow when a bot-link state matches', async () => {
    const handleOAuthCallback = jest.fn(async () => ({
      organizationId: ORGANIZATION_ID,
      installation: {
        accessToken: 'tok',
        botUserId: 'bot-1',
        organizationId: ORGANIZATION_ID,
        expiresAt: null,
      },
    }));
    mockedBotGetAdapter.mockReturnValue({
      handleOAuthCallback,
      deleteInstallation: jest.fn(async () => undefined),
    } as never);

    await callLinearCallback(
      makeRequest('/api/integrations/linear/callback?code=abc&state=signed-bot-link')
    );

    expect(handleOAuthCallback).not.toHaveBeenCalled();
  });
});
