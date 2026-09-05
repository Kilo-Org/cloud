import { beforeEach, describe, expect, test } from '@jest/globals';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { verifyGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { exchangeGitHubOAuthCode } from '@/lib/integrations/platforms/github/adapter';
import { linkKiloUser } from '@/lib/bot-identity';
import { bot } from '@/lib/bot';
import { failureResult } from '@/lib/maybe-result';
import { consumeInstallState } from '@/lib/integrations/github/install-state';
import type * as InstallStateModule from '@/lib/integrations/github/install-state';
import { db } from '@/lib/drizzle';
import {
  github_install_states,
  kilocode_users,
  type GitHubInstallState,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  findIntegrationByInstallationId,
  upsertPlatformIntegrationForOwner,
} from '@/lib/integrations/db/platform-integrations';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { verifyGitHubInstallationAuthorization } from '@/lib/integrations/github/installation-authorization';
import { captureException, captureMessage } from '@sentry/nextjs';
import type { StateAdapter } from 'chat';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { assertUserAdministersInstallation } from '@/lib/integrations/platforms/github/app-selector';

const mockState = { kind: 'state' } as unknown as StateAdapter;

jest.mock('@/lib/user/server');
jest.mock('@/lib/bot/github-link-state');
jest.mock('@/lib/bot-identity');
jest.mock('@/lib/integrations/platforms/github/adapter');
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(() => mockState),
  },
}));
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    apps: {
      getInstallation: jest.fn(),
      listReposAccessibleToInstallation: jest.fn(),
    },
  })),
}));
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: jest.fn(() => ({
    appId: 'app-id',
    privateKey: 'private-key',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    appName: 'KiloConnect',
    webhookSecret: 'webhook-secret',
  })),
  assertUserAdministersInstallation: jest.fn(async () => true),
}));
jest.mock('@/lib/integrations/github/installation-authorization', () => ({
  verifyGitHubInstallationAuthorization: jest.fn(async () => ({
    identity: { id: GITHUB_USER_ID, login: 'octocat' },
    candidate: {
      installationId: INSTALLATION_ID,
      accountId: '1',
      accountLogin: 'octocat',
      accountType: 'Organization',
    },
  })),
}));
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  createPendingIntegration: jest.fn(),
  findIntegrationByInstallationId: jest.fn(),
  findPendingInstallationByRequesterId: jest.fn(),
  upsertPlatformIntegrationForOwner: jest.fn(async () => ({ ok: true })),
}));
jest.mock('@/lib/organizations/organizations', () => ({
  isOrganizationMember: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/integrations/github/install-state', () => ({
  consumeInstallState: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedVerifyGitHubBotLinkState = jest.mocked(verifyGitHubBotLinkState);
const mockedExchangeGitHubOAuthCode = jest.mocked(exchangeGitHubOAuthCode);
const mockedLinkKiloUser = jest.mocked(linkKiloUser);
const mockedBot = jest.mocked(bot);
const mockedFindIntegrationByInstallationId = jest.mocked(findIntegrationByInstallationId);
const mockedCreateAppAuth = jest.mocked(createAppAuth);
const mockedOctokit = jest.mocked(Octokit);
const mockedUpsertPlatformIntegrationForOwner = jest.mocked(upsertPlatformIntegrationForOwner);
const mockedIsOrganizationMember = jest.mocked(isOrganizationMember);
const mockedConsumeInstallState = jest.mocked(consumeInstallState);
const mockedVerifyGitHubInstallationAuthorization = jest.mocked(
  verifyGitHubInstallationAuthorization
);
const mockedCaptureException = jest.mocked(captureException);
const mockedCaptureMessage = jest.mocked(captureMessage);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockedAssertUserAdministersInstallation = jest.mocked(assertUserAdministersInstallation);

function mockConsumedInstallState(state: GitHubInstallState) {
  mockedConsumeInstallState.mockResolvedValue({ status: 'success', state });
}

const USER_ID = 'oauth/test-callback-alice';
const OTHER_USER_ID = 'test-callback-bob';
const GITHUB_USER_ID = '12345';
const INSTALLATION_ID = '98765';
const INSTALL_STATE_TOKEN = 'valid-database-token-for-callback-tests';

beforeEach(() => {
  mockedConsumeInstallState.mockReset();
  mockedConsumeInstallState.mockResolvedValue({ status: 'unusable', reason: 'not_found' });
  mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({ ok: true });
  mockedExchangeGitHubOAuthCode.mockResolvedValue({
    id: GITHUB_USER_ID,
    login: 'octocat',
    accessToken: 'ghu_test-token',
  });
  mockedVerifyGitHubInstallationAuthorization.mockResolvedValue({
    identity: { id: GITHUB_USER_ID, login: 'octocat' },
    candidate: {
      installationId: INSTALLATION_ID,
      accountId: '1',
      accountLogin: 'octocat',
      accountType: 'Organization',
    },
  });
  mockedAssertUserAdministersInstallation.mockResolvedValue(true);
});

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('GET /api/integrations/github/callback bot link flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue({
      userId: USER_ID,
      installationId: INSTALLATION_ID,
      callbackPath: '/github/link',
    });
    mockedExchangeGitHubOAuthCode.mockResolvedValue({
      id: GITHUB_USER_ID,
      login: 'octocat',
      accessToken: 'test-token',
    });
    mockedFindIntegrationByInstallationId.mockResolvedValue({
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      github_app_type: 'standard',
      metadata: null,
    } as never);
    mockedIsOrganizationMember.mockResolvedValue(true);
  });

  test('redirects unauthenticated bot-link callbacks to existing callback auth fallback', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/');
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects invalid bot-link state without running installation callback logic', async () => {
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=bad') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?error=install_state_invalid');
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects bot-link state user mismatches', async () => {
    mockedVerifyGitHubBotLinkState.mockReturnValue({
      userId: OTHER_USER_ID,
      installationId: INSTALLATION_ID,
      callbackPath: '/github/link',
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('started by another Kilo user');
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects bot-link callbacks when the Kilo user cannot access the integration owner', async () => {
    mockedIsOrganizationMember.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain(
      'not a member of the organization that owns this GitHub integration'
    );
    expect(mockedFindIntegrationByInstallationId).toHaveBeenCalledWith('github', INSTALLATION_ID);
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('links the OAuth-verified GitHub user per installation', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('GitHub account octocat has been linked');
    expect(mockedExchangeGitHubOAuthCode).toHaveBeenCalledWith('abc', 'standard');
    expect(mockedFindIntegrationByInstallationId).toHaveBeenCalledWith('github', INSTALLATION_ID);
    expect(mockedIsOrganizationMember).toHaveBeenCalledWith('org_1', USER_ID);
    expect(mockedBot.initialize).toHaveBeenCalled();
    expect(mockedLinkKiloUser).toHaveBeenCalledWith(
      mockState,
      { platform: 'github', teamId: INSTALLATION_ID, userId: GITHUB_USER_ID },
      USER_ID
    );
  });

  test("exchanges the OAuth code against the integration's github_app_type", async () => {
    mockedFindIntegrationByInstallationId.mockResolvedValue({
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      github_app_type: 'lite',
      metadata: null,
    } as never);

    const { GET } = await import('./route');
    await GET(makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never);

    expect(mockedExchangeGitHubOAuthCode).toHaveBeenCalledWith('abc', 'lite');
  });
});

describe('GET /api/integrations/github/callback installation flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: USER_ID,
        google_user_email: 'mobile-e2e@example.com',
        google_user_name: 'Mobile E2E',
      },
      authFailedResponse: null,
    } as never);
    mockedCreateAppAuth.mockReturnValue(
      jest.fn(async () => ({ token: 'github-app-token' })) as never
    );
    mockedOctokit.mockImplementation(
      () =>
        ({
          apps: {
            getInstallation: jest.fn(async () => ({
              data: {
                account: { id: 12_345, login: 'securexg' },
                created_at: '2026-07-09T19:00:00.000Z',
                events: ['issues'],
                permissions: { contents: 'write' },
                repository_selection: 'all',
              },
            })),
            listReposAccessibleToInstallation: jest.fn(),
          },
        }) as never
    );
    mockConsumedInstallState({
      token: INSTALL_STATE_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/github-app',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });
  });

  test('associates an existing installation after GitHub updates its configuration', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=update&state=${INSTALL_STATE_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?github_install=success');
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      expect.objectContaining({
        platform: 'github',
        integrationType: 'app',
        platformInstallationId: INSTALLATION_ID,
        platformAccountLogin: 'securexg',
      })
    );
  });
});

describe('GET /api/integrations/github/callback database-backed install flow', () => {
  const DB_TOKEN = 'valid-database-token-' + Date.now();

  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: USER_ID,
        google_user_email: 'mobile-e2e@example.com',
        google_user_name: 'Mobile E2E',
      },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);
    mockedCreateAppAuth.mockReturnValue(
      jest.fn(async () => ({ token: 'github-app-token' })) as never
    );
    mockedOctokit.mockImplementation(
      () =>
        ({
          apps: {
            getInstallation: jest.fn(async () => ({
              data: {
                account: { id: 12_345, login: 'securexg' },
                created_at: '2026-07-09T19:00:00.000Z',
                events: ['issues'],
                permissions: { contents: 'write' },
                repository_selection: 'all',
              },
            })),
            listReposAccessibleToInstallation: jest.fn(),
          },
        }) as never
    );
  });

  test('completes a callback using a valid database-minted token', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/github-app',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?github_install=success');
    // The token consumed by the callback must be bare — no return suffix.
    expect(DB_TOKEN).not.toContain('|');
    expect(DB_TOKEN).not.toContain('return');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(DB_TOKEN, USER_ID);
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      expect.objectContaining({
        platform: 'github',
        integrationType: 'app',
        platformInstallationId: INSTALLATION_ID,
      })
    );
  });

  test('consumes a bare token and rejects suffixed tokens (producer-shaped state)', async () => {
    // Simulate the real DB: only the bare token returns a row.
    // A suffixed token never matches the stored bare token.
    const mockRow: GitHubInstallState = {
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/github-app',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    };
    mockedConsumeInstallState.mockImplementation(async (token: string) => {
      return token === DB_TOKEN
        ? { status: 'success', state: mockRow }
        : { status: 'unusable', reason: 'not_found' };
    });

    const { GET } = await import('./route');

    const suffixed = `${DB_TOKEN}|return=${encodeURIComponent('/github-app')}`;
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${encodeURIComponent(suffixed)}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?error=install_state_invalid');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(suffixed, USER_ID);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('rejects foreign state before any GitHub or integration side effects', async () => {
    mockedConsumeInstallState.mockResolvedValue({
      status: 'user_mismatch',
      organizationId: 'test-organization',
      returnTo: null,
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?error=install_state_user_mismatch');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(DB_TOKEN, USER_ID);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedCreateAppAuth).not.toHaveBeenCalled();
    expect(mockedOctokit).not.toHaveBeenCalled();
    expect(mockedVerifyGitHubInstallationAuthorization).not.toHaveBeenCalled();
    expect(mockedVerifyGitHubBotLinkState).not.toHaveBeenCalled();
    const { createPendingIntegration } =
      await import('@/lib/integrations/db/platform-integrations');
    expect(createPendingIntegration).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'GitHub install state presented by different user',
      {
        level: 'warning',
        tags: { endpoint: 'github/callback', source: 'install_state_user_mismatch' },
      }
    );
  });

  test('redirects with fromApp=1 when user mismatch on app-initiated state', async () => {
    mockedConsumeInstallState.mockResolvedValue({
      status: 'user_mismatch',
      organizationId: null,
      returnTo: '/cloud/sessions',
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?error=install_state_user_mismatch&fromApp=1');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(DB_TOKEN, USER_ID);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('a callback after a session switch leaves real state usable by its initiator', async () => {
    const stateModule = jest.requireActual<typeof InstallStateModule>(
      '@/lib/integrations/github/install-state'
    );
    const initiatorId = `oauth/callback-db-${randomUUID()}`;
    await db.insert(kilocode_users).values({
      id: initiatorId,
      google_user_email: `callback-db-${randomUUID()}@example.com`,
      google_user_name: 'Test Initiator',
      google_user_image_url: '',
      stripe_customer_id: 'cus_test_callback',
    });
    try {
      const token = await stateModule.createInstallState({
        kiloUserId: initiatorId,
        ownerType: 'user',
        ownerId: initiatorId,
        githubAppType: 'standard',
        returnTo: '/cloud/sessions',
      });
      await expect(stateModule.checkInstallState(token, initiatorId)).resolves.toEqual({
        status: 'valid',
      });
      mockedConsumeInstallState.mockImplementation(stateModule.consumeInstallState);
      const { GET } = await import('./route');
      const callbackPath = `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${token}&code=test-code`;
      const rejected = await GET(makeRequest(callbackPath));
      expectRedirectLocation(rejected, '/github-app?error=install_state_user_mismatch&fromApp=1');
      const [state] = await db
        .select({ consumedAt: github_install_states.consumed_at })
        .from(github_install_states)
        .where(eq(github_install_states.token, token));
      expect(state).toEqual({ consumedAt: null });
      expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
      expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
      expect(mockedOctokit).not.toHaveBeenCalled();

      mockedGetUserFromAuth.mockResolvedValue({
        user: { id: initiatorId, google_user_email: 'test@example.com', google_user_name: 'Test' },
        authFailedResponse: null,
      } as never);
      const accepted = await GET(makeRequest(callbackPath));
      expectRedirectLocation(accepted, '/github-app?fromApp=1&github_install=success');
      expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalledTimes(1);
      expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalledWith(
        { type: 'user', id: initiatorId },
        expect.anything()
      );
      const replayed = await GET(makeRequest(callbackPath));
      expectRedirectLocation(replayed, '/github-app?error=install_state_invalid');
      expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalledTimes(1);
    } finally {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, initiatorId));
    }
  });

  test('preserves organization recovery context for an app-initiated mismatch', async () => {
    mockedConsumeInstallState.mockResolvedValue({
      status: 'user_mismatch',
      organizationId: 'test-organization',
      returnTo: '/cloud/sessions',
    });
    const { GET } = await import('./route');
    const response = await GET(makeRequest(`/api/integrations/github/callback?state=${DB_TOKEN}`));
    expectRedirectLocation(
      response,
      '/github-app?error=install_state_user_mismatch&fromApp=1&organizationId=test-organization'
    );
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test.each(['consumed', 'expired', 'not_found', 'unavailable'] as const)(
    'recovers a %s token without OAuth or installation writes',
    async reason => {
      mockedConsumeInstallState.mockResolvedValue({ status: 'unusable', reason });

      const { GET } = await import('./route');
      const response = await GET(
        makeRequest(
          `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=synthetic-oauth-code&organizationId=untrusted-org&fromApp=1`
        ) as never
      );

      expect(response.status).toBe(307);
      expectRedirectLocation(response, '/github-app?error=install_state_invalid');
      expect(mockedConsumeInstallState).toHaveBeenCalledWith(DB_TOKEN, USER_ID);
      expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
      expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
      expect(mockedCreateAppAuth).not.toHaveBeenCalled();
      const { createPendingIntegration } =
        await import('@/lib/integrations/db/platform-integrations');
      expect(createPendingIntegration).not.toHaveBeenCalled();
      expect(mockedCaptureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          level: reason === 'expired' || reason === 'consumed' ? 'info' : 'warning',
          extra: expect.objectContaining({ stateClass: 'install_token', rejectionReason: reason }),
        })
      );
      const diagnostics = JSON.stringify(mockedCaptureMessage.mock.calls);
      for (const value of [DB_TOKEN, USER_ID, INSTALLATION_ID]) {
        expect(diagnostics).not.toContain(value);
      }
    }
  );

  test('treats a prefixed state as opaque when it matches a database token', async () => {
    const PREFIXED_DB_TOKEN = `user_${DB_TOKEN}`;
    mockConsumedInstallState({
      token: PREFIXED_DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'org',
      owner_id: 'org-db-owner',
      github_app_type: 'standard',
      return_to: '/github-app',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${PREFIXED_DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?github_install=success');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(PREFIXED_DB_TOKEN, USER_ID);
    // The owner always comes from the database row, never from token contents.
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'org', id: 'org-db-owner' },
      expect.objectContaining({ platform: 'github' })
    );
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: USER_ID }) }),
      'org-db-owner',
      ['owner', 'admin']
    );
  });

  test('revalidates organization management access before storing an installation', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'org',
      owner_id: 'org-demoted',
      github_app_type: 'standard',
      return_to: '/organizations/org-demoted/integrations/github',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });
    mockedEnsureOrganizationAccess.mockRejectedValueOnce(new Error('Organization role required'));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expectRedirectLocation(response, '/?error=installation_failed');
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('handles a database-minted token with returnTo', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'org',
      owner_id: 'org-456',
      github_app_type: 'lite',
      return_to: '/organizations/org-456/integrations/github',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    // Override to return the matching org owner
    jest.doMock('@/routers/organizations/utils', () => ({
      ensureOrganizationAccess: jest.fn(),
    }));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      '/organizations/org-456/integrations/github?github_install=success'
    );
  });

  test('redirects to /github-app fallback (not /cloud/sessions) for app-initiated success', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      // App-initiated: return_to is /cloud/sessions — claimed UL route.
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    // Must redirect to /github-app fallback page, not /cloud/sessions.
    expectRedirectLocation(response, '/github-app?fromApp=1&github_install=success');
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });

  test('redirects to /github-app fallback for app-initiated pending approval', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { createPendingIntegration } =
      await import('@/lib/integrations/db/platform-integrations');
    const mockedCreatePending = jest.mocked(createPendingIntegration);
    mockedCreatePending.mockResolvedValue(undefined as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=request&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?fromApp=1&github_pending_approval=true');
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('rejects non-/cloud/ returnTo as non-app (no fallback redirect)', async () => {
    // A non-app returnTo must not trigger the /github-app fallback.
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'org',
      owner_id: 'org-attacker',
      github_app_type: 'standard',
      return_to: '/organizations/org-attacker/integrations/github',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    jest.doMock('@/routers/organizations/utils', () => ({
      ensureOrganizationAccess: jest.fn(),
    }));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    // Non-app returnTo: redirect to integration path, not /github-app.
    expectRedirectLocation(
      response,
      '/organizations/org-attacker/integrations/github?github_install=success'
    );
  });

  test('app-initiated installation_already_claimed redirects to /github-app fallback', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({
      ok: false,
      reason: 'claimed_by_other_owner',
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?fromApp=1&error=installation_already_claimed');
  });

  test('app-initiated missing_installation_id redirects to /github-app fallback', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?fromApp=1&error=missing_installation_id');
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('app-initiated installation_not_found redirects to /github-app fallback', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });
    mockedOctokit.mockImplementation(
      () =>
        ({
          apps: {
            getInstallation: jest.fn(async () => {
              const err = Object.assign(new Error('Not Found'), { status: 404 });
              throw err;
            }),
            listReposAccessibleToInstallation: jest.fn(),
          },
        }) as never
    );

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?fromApp=1&error=installation_not_found');
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('ambiguous app-initiated pending request returns successful pending no-op', async () => {
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=request&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?fromApp=1&github_pending_approval=true');
  });

  test('app-initiated org success preserves organizationId on redirect', async () => {
    const ORG_ID = 'org-789';
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({ ok: true });
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'org',
      owner_id: ORG_ID,
      github_app_type: 'standard',
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    jest.doMock('@/routers/organizations/utils', () => ({
      ensureOrganizationAccess: jest.fn(),
    }));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      `/github-app?fromApp=1&github_install=success&organizationId=${ORG_ID}`
    );
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });

  test('app-initiated user success omits organizationId', async () => {
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({ ok: true });
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    // No organizationId for user-scoped install.
    expectRedirectLocation(response, '/github-app?fromApp=1&github_install=success');
  });

  test('app-initiated org pending approval preserves organizationId', async () => {
    const ORG_ID = 'org-pending';
    mockConsumedInstallState({
      token: DB_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'org',
      owner_id: ORG_ID,
      github_app_type: 'standard',
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { createPendingIntegration } =
      await import('@/lib/integrations/db/platform-integrations');
    const mockedCreatePending = jest.mocked(createPendingIntegration);
    mockedCreatePending.mockResolvedValue(undefined as never);

    jest.doMock('@/routers/organizations/utils', () => ({
      ensureOrganizationAccess: jest.fn(),
    }));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=request&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      `/github-app?fromApp=1&github_pending_approval=true&organizationId=${ORG_ID}`
    );
  });
});

describe('GET /api/integrations/github/callback plaintext state rejection', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: USER_ID,
        google_user_email: 'mobile-e2e@example.com',
        google_user_name: 'Mobile E2E',
      },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);
    mockedConsumeInstallState.mockResolvedValue({ status: 'unusable', reason: 'not_found' });
  });

  test.each(['org_', 'user_'])('always rejects %s prefixed plaintext state', async prefix => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${prefix}${USER_ID}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?error=install_state_invalid');
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedCreateAppAuth).not.toHaveBeenCalled();
    const serializedMessage = JSON.stringify(mockedCaptureMessage.mock.calls);
    expect(serializedMessage).not.toContain(`${prefix}${USER_ID}`);
    expect(serializedMessage).toContain('state_not_bot_link_or_install_token');
  });
});

describe('GET /api/integrations/github/callback admin proof', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: USER_ID,
        google_user_email: 'mobile-e2e@example.com',
        google_user_name: 'Mobile E2E',
      },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);
    mockConsumedInstallState({
      token: INSTALL_STATE_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: null,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });
    mockedCreateAppAuth.mockReturnValue(
      jest.fn(async () => ({ token: 'github-app-token' })) as never
    );
    mockedOctokit.mockImplementation(
      () =>
        ({
          apps: {
            getInstallation: jest.fn(async () => ({
              data: {
                account: { id: 12_345, login: 'securexg' },
                created_at: '2026-07-09T19:00:00.000Z',
                events: ['issues'],
                permissions: { contents: 'write' },
                repository_selection: 'all',
              },
            })),
            listReposAccessibleToInstallation: jest.fn(),
          },
        }) as never
    );
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({ ok: true });
    mockedVerifyGitHubInstallationAuthorization.mockResolvedValue({
      identity: { id: GITHUB_USER_ID, login: 'octocat' },
      candidate: {
        installationId: INSTALLATION_ID,
        accountId: '1',
        accountLogin: 'octocat',
        accountType: 'Organization',
      },
    });
    mockedExchangeGitHubOAuthCode.mockResolvedValue({
      id: GITHUB_USER_ID,
      login: 'octocat',
      accessToken: 'ghu_test-token',
    });
  });

  test('rejects an install when code is absent', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${INSTALL_STATE_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?error=not_installation_admin`);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedVerifyGitHubInstallationAuthorization).not.toHaveBeenCalled();
    expect(mockedCreateAppAuth).not.toHaveBeenCalled();
  });

  test('completes an install when code is present and user is admin', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${INSTALL_STATE_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?success=installed`);
    expect(mockedExchangeGitHubOAuthCode).toHaveBeenCalledWith('abc', 'standard');
    expect(mockedAssertUserAdministersInstallation).toHaveBeenCalledWith({
      accessToken: 'ghu_test-token',
      installationId: INSTALLATION_ID,
    });
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });

  test('rejects an install when admin check returns false', async () => {
    mockedAssertUserAdministersInstallation.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${INSTALL_STATE_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?error=not_installation_admin`);
    expect(mockedExchangeGitHubOAuthCode).toHaveBeenCalled();
    expect(mockedAssertUserAdministersInstallation).toHaveBeenCalled();
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockedCreateAppAuth).not.toHaveBeenCalled();
  });

  test('rejects an install when code exchange fails', async () => {
    mockedExchangeGitHubOAuthCode.mockRejectedValue(new Error('Token exchange failed'));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${INSTALL_STATE_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?error=not_installation_admin`);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockedCreateAppAuth).not.toHaveBeenCalled();
  });

  test('redirects with installation_already_claimed when upsert detects cross-owner claim', async () => {
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({
      ok: false,
      reason: 'claimed_by_other_owner',
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${INSTALL_STATE_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?error=installation_already_claimed`);
  });

  test('redirects when multiple installations are disabled for the organization', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000001';
    mockConsumedInstallState({
      token: INSTALL_STATE_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'org',
      owner_id: organizationId,
      github_app_type: 'standard',
      return_to: null,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({
      ok: false,
      reason: 'multiple_installations_disabled',
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${INSTALL_STATE_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      `/organizations/${organizationId}/integrations/github?error=multiple_installations_disabled`
    );
  });

  test('logs distinct messages for code-absent vs non-admin', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Case 1: code absent — should log code_absent.
    const { GET } = await import('./route');
    await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${INSTALL_STATE_TOKEN}`
      ) as never
    );

    const codeAbsentLogs = logSpy.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && (call[0] as string).includes('[github_admin_proof')
    );
    expect(codeAbsentLogs.length).toBeGreaterThan(0);
    expect(codeAbsentLogs[0][0]).toContain('code_absent');
    expect(codeAbsentLogs[0][0]).not.toContain('fail_non_admin');

    logSpy.mockClear();

    // Case 2: code present but non-admin — should log fail_non_admin.
    mockedAssertUserAdministersInstallation.mockResolvedValue(false);
    await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${INSTALL_STATE_TOKEN}&code=abc`
      ) as never
    );

    const nonAdminLogs = logSpy.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && (call[0] as string).includes('[github_admin_proof')
    );
    expect(nonAdminLogs.length).toBeGreaterThan(0);
    expect(nonAdminLogs[0][0]).toContain('fail_non_admin');
    expect(nonAdminLogs[0][0]).not.toContain('code_absent');

    logSpy.mockRestore();
  });
});

describe('GET /api/integrations/github/callback Sentry redaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: USER_ID,
        google_user_email: 'mobile-e2e@example.com',
        google_user_name: 'Mobile E2E',
      },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);
    mockedConsumeInstallState.mockResolvedValue({ status: 'unusable', reason: 'not_found' });
    mockedCreateAppAuth.mockReturnValue(
      jest.fn(async () => ({ token: 'github-app-token' })) as never
    );
    mockedOctokit.mockImplementation(
      () =>
        ({
          apps: {
            getInstallation: jest.fn(async () => ({
              data: {
                account: { id: 12_345, login: 'securexg' },
                created_at: '2026-07-09T19:00:00.000Z',
                events: ['issues'],
                permissions: { contents: 'write' },
                repository_selection: 'all',
              },
            })),
            listReposAccessibleToInstallation: jest.fn(),
          },
        }) as never
    );
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({ ok: true });
  });

  test('unrecognized-state warning does not include the raw state token', async () => {
    const RAW_TOKEN = `sentry-redaction-unknown-${Date.now()}`;
    mockedConsumeInstallState.mockResolvedValue({ status: 'unusable', reason: 'not_found' });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${RAW_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?error=install_state_invalid');
    expect(mockedCaptureMessage).toHaveBeenCalled();
    const serializedMessage = JSON.stringify(mockedCaptureMessage.mock.calls);
    // The raw state is a bearer token and must never reach Sentry.
    expect(serializedMessage).not.toContain(RAW_TOKEN);
    expect(serializedMessage).toContain('install_token');
    expect(serializedMessage).toContain('state_not_bot_link_or_install_token');
    expect(serializedMessage).not.toContain(INSTALLATION_ID);
    expect(serializedMessage).toContain('not_found');
  });

  test('catch-path exception does not include the raw state token', async () => {
    const RAW_TOKEN = `sentry-redaction-catch-${Date.now()}`;
    mockConsumedInstallState({
      token: RAW_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: null,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });
    mockedOctokit.mockImplementation(
      () =>
        ({
          apps: {
            getInstallation: jest.fn(async () => {
              throw new Error('get installation failed');
            }),
            listReposAccessibleToInstallation: jest.fn(),
          },
        }) as never
    );

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${RAW_TOKEN}&code=abc`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/?error=installation_failed');
    expect(mockedCaptureException).toHaveBeenCalled();
    const serializedException = JSON.stringify(mockedCaptureException.mock.calls);
    // The raw state is a bearer token and must never reach Sentry.
    expect(serializedException).not.toContain(RAW_TOKEN);
    // Safe diagnostics survive: state class, reason, and the callback ids.
    expect(serializedException).toContain('install_token');
    expect(serializedException).toContain('callback_flow_error');
    expect(serializedException).toContain(INSTALLATION_ID);
  });

  test('missing-installation diagnostic does not include the raw state token or params', async () => {
    const RAW_TOKEN = `missing-installation-${Date.now()}`;
    mockConsumedInstallState({
      token: RAW_TOKEN,
      kilo_user_id: USER_ID,
      owner_type: 'user',
      owner_id: USER_ID,
      github_app_type: 'standard',
      return_to: null,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?setup_action=install&state=${RAW_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/github?error=missing_installation_id');
    expect(mockedCaptureMessage).toHaveBeenCalled();
    const serializedMessage = JSON.stringify(mockedCaptureMessage.mock.calls);
    // The raw state is a bearer token and must never reach Sentry.
    expect(serializedMessage).not.toContain(RAW_TOKEN);
    // Safe diagnostics survive: state class, reason, and the setup action.
    expect(serializedMessage).toContain('install_token');
    expect(serializedMessage).toContain('missing_installation_id');
    expect(serializedMessage).toContain('setupAction');
  });
});
