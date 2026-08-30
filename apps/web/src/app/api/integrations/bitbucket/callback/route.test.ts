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

jest.mock('@/lib/constants', () => ({ APP_URL: 'http://localhost:3000' }));
jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'callback-state-test-secret' }));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/bitbucket/adapter', () => ({
  BitbucketOAuthScopeError: class extends Error {},
  exchangeBitbucketOAuthCode: jest.fn(),
  fetchBitbucketUser: jest.fn(),
  fetchBitbucketWorkspaces: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/bitbucket/credentials', () => ({
  BitbucketIntegrationAuthorizationError: class BitbucketIntegrationAuthorizationError extends Error {},
  BitbucketIntegrationConnectionConflictError: class BitbucketIntegrationConnectionConflictError extends Error {},
  BitbucketIntegrationRecoveryError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
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

const RECOVERY = {
  integrationId: '33333333-3333-4333-8333-333333333333',
  credentialId: '44444444-4444-4444-8444-444444444444',
  credentialVersion: 2,
  workspaceUuid: 'workspace-one',
  workspaceSlug: 'workspace-one',
};
const WRITE_TOKENS = {
  ...BITBUCKET_TOKENS,
  scopes: [...BITBUCKET_TOKENS.scopes, 'pullrequest:write'],
};
const OLD_TOKENS = { ...BITBUCKET_TOKENS, accessToken: 'old-access', refreshToken: 'old-refresh' };
let persistedTokens: BitbucketOAuthTokens;

function recoveryState() {
  return createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID, undefined, RECOVERY);
}

function expectRecoveryError(response: Response, code: string) {
  expectRedirectLocation(
    response,
    `/organizations/${ORGANIZATION_ID}/integrations/bitbucket?error=${code}`
  );
  expect(persistedTokens).toEqual(OLD_TOKENS);
}

describe('Bitbucket OAuth recovery callback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    persistedTokens = OLD_TOKENS;
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedExchangeBitbucketOAuthCode.mockResolvedValue(WRITE_TOKENS);
    mockedFetchBitbucketUser.mockResolvedValue(BITBUCKET_USER);
    mockedFetchBitbucketWorkspaces.mockResolvedValue([WORKSPACE]);
    mockedStoreBitbucketIntegration.mockImplementation(async input => {
      // This boundary rejects ordinary first-connect, just like the existing stored connection.
      if (!input.bitbucketRecovery) throw new BitbucketIntegrationConnectionConflictError();
      expect(input.owner).toEqual({ type: 'org', id: ORGANIZATION_ID });
      expect(input.authorizedByUserId).toBe(USER_ID);
      expect(input.bitbucketRecovery).toEqual(RECOVERY);
      persistedTokens = input.tokens;
      return { status: 'connected', integrationId: RECOVERY.integrationId };
    });
  });

  test('passes signed recovery through the real public callback without workspace selection', async () => {
    mockedFetchBitbucketWorkspaces.mockResolvedValue([
      WORKSPACE,
      { uuid: '{workspace-two}', slug: 'workspace-two', name: 'Two' },
    ]);
    const response = await callPublicBitbucketCallback(makeRequest(recoveryState()));
    expectRedirectLocation(
      response,
      `/organizations/${ORGANIZATION_ID}/integrations/bitbucket?success=connected`
    );
    expect(persistedTokens).toEqual(WRITE_TOKENS);
  });

  test.each([
    ['access_denied', 'authorization_cancelled'],
    ['server_error', 'connection_failed'],
    ['invalid_scope', 'missing_scopes'],
  ])('retains the existing connection after provider error %s', async (error, expectedError) => {
    const request = makeRequest(recoveryState());
    request.nextUrl.searchParams.set('error', error);
    expectRecoveryError(await callPublicBitbucketCallback(request), expectedError);
  });

  test('retains credentials when the provider returns no authorization code', async () => {
    const request = makeRequest(recoveryState());
    request.nextUrl.searchParams.delete('code');
    expectRecoveryError(await callPublicBitbucketCallback(request), 'missing_code');
  });

  test('rejects unsigned replacement selectors even with valid first-connect state', async () => {
    const request = makeRequest(createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID));
    request.nextUrl.searchParams.set('reconnectIntegrationId', RECOVERY.integrationId);
    const response = await callPublicBitbucketCallback(request);
    expectRecoveryError(response, 'invalid_state');
  });

  test('preserves the legacy first-connect provider error redirect', async () => {
    const request = makeRequest(createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID));
    request.nextUrl.searchParams.set('error', 'server_error');
    expectRecoveryError(await callPublicBitbucketCallback(request), 'authorization_cancelled');
  });

  test('retains the first-connect conflict when recovery is not signed', async () => {
    expectRecoveryError(
      await callPublicBitbucketCallback(
        makeRequest(createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID))
      ),
      'connection_exists'
    );
  });

  test('rejects a different callback actor before replacing credentials', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'oauth/different-user' },
      authFailedResponse: null,
    } as never);
    expectRecoveryError(
      await callPublicBitbucketCallback(makeRequest(recoveryState())),
      'unauthorized'
    );
  });

  test('rechecks the organization role before replacing credentials', async () => {
    const { ensureOrganizationAccess } = await import('@/routers/organizations/utils');
    jest.mocked(ensureOrganizationAccess).mockRejectedValue(new Error('management denied'));
    expectRecoveryError(
      await callPublicBitbucketCallback(makeRequest(recoveryState())),
      'unauthorized'
    );
  });

  test('retains credentials if manager authorization changes during persistence', async () => {
    mockedStoreBitbucketIntegration.mockRejectedValue(
      new BitbucketIntegrationAuthorizationError('authorization revoked')
    );
    expectRecoveryError(
      await callPublicBitbucketCallback(makeRequest(recoveryState())),
      'unauthorized'
    );
  });

  test('rejects tampered signed recovery without trusting its organization', async () => {
    const state = recoveryState();
    const [encoded, signature] = state.split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    payload.bitbucketRecovery = {
      ...RECOVERY,
      integrationId: '55555555-5555-4555-8555-555555555555',
    };
    const response = await callPublicBitbucketCallback(
      makeRequest(`${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`)
    );
    expectRedirectLocation(response, '/integrations/bitbucket?error=invalid_state');
    expect(persistedTokens).toEqual(OLD_TOKENS);
  });

  test('does not replace read credentials with another read-only grant', async () => {
    mockedExchangeBitbucketOAuthCode.mockResolvedValue(BITBUCKET_TOKENS);
    expectRecoveryError(
      await callPublicBitbucketCallback(makeRequest(recoveryState())),
      'missing_scopes'
    );
  });

  test('retains credentials when the account has no workspaces', async () => {
    mockedFetchBitbucketWorkspaces.mockResolvedValue([]);
    expectRecoveryError(
      await callPublicBitbucketCallback(makeRequest(recoveryState())),
      'workspace_unavailable'
    );
  });

  test('explains missing base scopes from the exchange as a permission requirement', async () => {
    const { BitbucketOAuthScopeError } =
      await import('@/lib/integrations/platforms/bitbucket/adapter');
    mockedExchangeBitbucketOAuthCode.mockRejectedValue(
      new BitbucketOAuthScopeError('scope_mismatch')
    );
    expectRecoveryError(
      await callPublicBitbucketCallback(makeRequest(recoveryState())),
      'missing_scopes'
    );
  });

  test.each(['connection_changed', 'workspace_unavailable', 'missing_scopes'] as const)(
    'reports a non-destructive persistence rejection: %s',
    async code => {
      const { BitbucketIntegrationRecoveryError } =
        await import('@/lib/integrations/platforms/bitbucket/credentials');
      mockedStoreBitbucketIntegration.mockRejectedValue(
        new BitbucketIntegrationRecoveryError(code)
      );
      expectRecoveryError(await callPublicBitbucketCallback(makeRequest(recoveryState())), code);
    }
  );

  test.each(['exchange', 'profile', 'workspaces', 'persistence'])(
    'retains credentials after a retryable %s failure',
    async phase => {
      const failure = new Error('Temporary provider or storage failure');
      if (phase === 'exchange') mockedExchangeBitbucketOAuthCode.mockRejectedValue(failure);
      if (phase === 'profile') mockedFetchBitbucketUser.mockRejectedValue(failure);
      if (phase === 'workspaces') mockedFetchBitbucketWorkspaces.mockRejectedValue(failure);
      if (phase === 'persistence') mockedStoreBitbucketIntegration.mockRejectedValue(failure);
      expectRecoveryError(
        await callPublicBitbucketCallback(makeRequest(recoveryState())),
        'connection_failed'
      );
    }
  );
});
