import { beforeEach, describe, expect, test } from '@jest/globals';
import { captureException } from '@sentry/nextjs';
import { NextRequest } from 'next/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import {
  exchangeBitbucketOAuthCode,
  fetchBitbucketUser,
  fetchBitbucketWorkspaces,
  type BitbucketOAuthTokens,
} from '@/lib/integrations/platforms/bitbucket/adapter';
import {
  BitbucketIntegrationAuthorizationError,
  BitbucketIntegrationConnectionConflictError,
  storeBitbucketIntegration,
} from '@/lib/integrations/platforms/bitbucket/credentials';
import { scheduleBitbucketRepositoryCachePrime } from '@/lib/integrations/platforms/bitbucket/repository-cache';
import { getUserFromAuth } from '@/lib/user/server';

jest.mock('@/lib/user/server');
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/bitbucket/adapter', () => ({
  exchangeBitbucketOAuthCode: jest.fn(),
  fetchBitbucketUser: jest.fn(),
  fetchBitbucketWorkspaces: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/bitbucket/credentials', () => ({
  BitbucketIntegrationAuthorizationError: class BitbucketIntegrationAuthorizationError extends Error {},
  BitbucketIntegrationConnectionConflictError: class BitbucketIntegrationConnectionConflictError extends Error {},
  storeBitbucketIntegration: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/bitbucket/repository-cache', () => ({
  scheduleBitbucketRepositoryCachePrime: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedCaptureException = jest.mocked(captureException);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedExchangeBitbucketOAuthCode = jest.mocked(exchangeBitbucketOAuthCode);
const mockedFetchBitbucketUser = jest.mocked(fetchBitbucketUser);
const mockedFetchBitbucketWorkspaces = jest.mocked(fetchBitbucketWorkspaces);
const mockedStoreBitbucketIntegration = jest.mocked(storeBitbucketIntegration);
const mockedScheduleBitbucketRepositoryCachePrime = jest.mocked(
  scheduleBitbucketRepositoryCachePrime
);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORGANIZATION_ID = '7e3011af-e99d-444f-8171-54c2225b87dc';
const BITBUCKET_TOKENS = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenType: 'bearer',
  expiresIn: 3600,
  scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
} satisfies BitbucketOAuthTokens;
const BITBUCKET_USER = {
  uuid: '{bitbucket-user}',
  nickname: 'bucket-user',
  displayName: 'Bucket User',
};
const WORKSPACE = {
  uuid: '{workspace-one}',
  slug: 'workspace-one',
  name: 'Workspace One',
};

function makeRequest(state: string) {
  return new NextRequest(
    `http://localhost:3000/api/integrations/bitbucket/callback?code=authorization-code&state=${encodeURIComponent(state)}`
  );
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

async function callBitbucketCallbackImplementation(request: NextRequest) {
  const { handleBitbucketOAuthCallback } =
    await import('@/lib/integrations/oauth/platforms/bitbucket-callback');
  return handleBitbucketOAuthCallback(request);
}

async function callPublicBitbucketCallback(request: NextRequest) {
  const { GET } = await import('../../[platform]/callback/route');
  return GET(request, { params: Promise.resolve({ platform: 'bitbucket' }) });
}

describe('GET /api/integrations/bitbucket/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedExchangeBitbucketOAuthCode.mockResolvedValue(BITBUCKET_TOKENS);
    mockedFetchBitbucketUser.mockResolvedValue(BITBUCKET_USER);
  });

  test('dispatches the public callback through the Bitbucket OAuth implementation', async () => {
    mockedFetchBitbucketWorkspaces.mockResolvedValue([WORKSPACE]);
    mockedStoreBitbucketIntegration.mockResolvedValue({
      status: 'connected',
      integrationId: 'integration-id',
    });
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);

    const response = await callPublicBitbucketCallback(makeRequest(state));

    expectRedirectLocation(response, '/integrations/bitbucket?success=connected');
    expect(mockedStoreBitbucketIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ availableWorkspaces: [WORKSPACE] })
    );
    expect(mockedScheduleBitbucketRepositoryCachePrime).toHaveBeenCalledWith({
      owner: { type: 'user', id: USER_ID },
      kiloUserId: USER_ID,
      integrationId: 'integration-id',
    });
  });

  test('keeps the implementation directly testable for personal support', async () => {
    mockedFetchBitbucketWorkspaces.mockResolvedValue([WORKSPACE]);
    mockedStoreBitbucketIntegration.mockResolvedValue({
      status: 'connected',
      integrationId: 'integration-id',
    });
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);

    const response = await callBitbucketCallbackImplementation(makeRequest(state));

    expectRedirectLocation(response, '/integrations/bitbucket?success=connected');
    expect(mockedStoreBitbucketIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ availableWorkspaces: [WORKSPACE] })
    );
    expect(mockedScheduleBitbucketRepositoryCachePrime).toHaveBeenCalledWith({
      owner: { type: 'user', id: USER_ID },
      kiloUserId: USER_ID,
      integrationId: 'integration-id',
    });
  });

  test('redirects multiple workspaces to explicit selection', async () => {
    const secondWorkspace = {
      uuid: '{workspace-two}',
      slug: 'workspace-two',
      name: 'Workspace Two',
    };
    mockedFetchBitbucketWorkspaces.mockResolvedValue([WORKSPACE, secondWorkspace]);
    mockedStoreBitbucketIntegration.mockResolvedValue({
      status: 'workspace_selection_required',
      integrationId: 'integration-id',
    });
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);

    const response = await callBitbucketCallbackImplementation(makeRequest(state));

    expectRedirectLocation(
      response,
      '/integrations/bitbucket?success=workspace_selection_required'
    );
  });

  test('does not replace an integration when no workspaces are available', async () => {
    mockedFetchBitbucketWorkspaces.mockResolvedValue([]);
    const state = createOAuthState(`user_${USER_ID}`, USER_ID);

    const response = await callBitbucketCallbackImplementation(makeRequest(state));

    expectRedirectLocation(response, '/integrations/bitbucket?error=no_workspaces');
    expect(mockedStoreBitbucketIntegration).not.toHaveBeenCalled();
  });

  test('reports authorization revoked during storage as unauthorized', async () => {
    mockedFetchBitbucketWorkspaces.mockResolvedValue([WORKSPACE]);
    mockedStoreBitbucketIntegration.mockRejectedValue(
      new BitbucketIntegrationAuthorizationError('authorization revoked')
    );
    const state = createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID);

    const response = await callBitbucketCallbackImplementation(makeRequest(state));

    expectRedirectLocation(
      response,
      `/organizations/${ORGANIZATION_ID}/integrations/bitbucket?error=unauthorized`
    );
    expect(mockedCaptureException).not.toHaveBeenCalled();
  });

  test('reports an existing Bitbucket connection without replacing it', async () => {
    mockedFetchBitbucketWorkspaces.mockResolvedValue([WORKSPACE]);
    mockedStoreBitbucketIntegration.mockRejectedValue(
      new BitbucketIntegrationConnectionConflictError()
    );
    const state = createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID);

    const response = await callPublicBitbucketCallback(makeRequest(state));

    expectRedirectLocation(
      response,
      `/organizations/${ORGANIZATION_ID}/integrations/bitbucket?error=connection_exists`
    );
    expect(mockedCaptureException).not.toHaveBeenCalled();
  });
});
