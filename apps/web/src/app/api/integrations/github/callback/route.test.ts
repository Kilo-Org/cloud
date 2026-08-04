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
import { getEnvVariable } from '@/lib/dotenvx';
import {
  findIntegrationByInstallationId,
  upsertPlatformIntegrationForOwner,
} from '@/lib/integrations/db/platform-integrations';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { assertUserAdministersInstallation } from '@/lib/integrations/platforms/github/app-selector';
import type { StateAdapter } from 'chat';

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
  getGitHubAppTypeForOrganization: jest.fn(async () => 'standard'),
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
jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: jest.fn((key: string) => process.env[key] ?? ''),
  requireEnv: (name: string, value: string | undefined) => {
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  },
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
const mockedGetEnvVariable = jest.mocked(getEnvVariable);
const mockedAssertUserAdministersInstallation = jest.mocked(assertUserAdministersInstallation);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const OTHER_USER_ID = 'c00b91a1-6959-4b04-9ef8-e8d37b340f4a';
const GITHUB_USER_ID = '12345';
const INSTALLATION_ID = '98765';

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
    mockedExchangeGitHubOAuthCode.mockResolvedValue({ id: GITHUB_USER_ID, login: 'octocat' });
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
    expectRedirectLocation(response, '/');
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
  });

  test('associates an existing installation after GitHub updates its configuration', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=update&state=user_${USER_ID}%7Creturn%3D%252Fgithub-app`
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
    mockedGetEnvVariable.mockReturnValue('true');
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
    mockedConsumeInstallState.mockResolvedValue({
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?github_install=success');
    // The token consumed by the callback must be bare — no return suffix.
    expect(DB_TOKEN).not.toContain('|');
    expect(DB_TOKEN).not.toContain('return');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(DB_TOKEN);
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
    const mockRow: Awaited<ReturnType<typeof consumeInstallState>> = {
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
      return token === DB_TOKEN ? mockRow : null;
    });

    const { GET } = await import('./route');

    // If a producer erroneously sends a suffixed state, consumeInstallState
    // receives the full suffix. The real DB returns null because it stores
    // only the bare token. The callback must redirect to the home page
    // instead of proceeding with the install.
    const suffixed = `${DB_TOKEN}|return=${encodeURIComponent('/github-app')}`;
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${encodeURIComponent(suffixed)}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(suffixed);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('rejects a token consumed by a different user (foreign state)', async () => {
    mockedConsumeInstallState.mockResolvedValue({
      token: DB_TOKEN,
      kilo_user_id: OTHER_USER_ID,
      owner_type: 'org',
      owner_id: 'org-123',
      github_app_type: 'standard',
      return_to: null,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?error=install_state_user_mismatch');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(DB_TOKEN);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('redirects with fromApp=1 when user mismatch on app-initiated state', async () => {
    mockedConsumeInstallState.mockResolvedValue({
      token: DB_TOKEN,
      kilo_user_id: OTHER_USER_ID,
      owner_type: 'user',
      owner_id: OTHER_USER_ID,
      github_app_type: 'standard',
      // App-initiated: return_to is /cloud/sessions (starts with /cloud/)
      return_to: '/cloud/sessions',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?error=install_state_user_mismatch&fromApp=1');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(DB_TOKEN);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('rejects a replayed (already consumed) token', async () => {
    mockedConsumeInstallState.mockResolvedValue(null);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    // Replayed tokens fall through to unrecognized state
    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/');
    expect(mockedConsumeInstallState).toHaveBeenCalledWith(DB_TOKEN);
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('handles a database-minted token with returnTo', async () => {
    mockedConsumeInstallState.mockResolvedValue({
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      '/organizations/org-456/integrations/github?github_install=success'
    );
  });

  test('redirects to /github-app fallback (not /cloud/sessions) for app-initiated success', async () => {
    mockedConsumeInstallState.mockResolvedValue({
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    // Must redirect to /github-app fallback page, not /cloud/sessions.
    expectRedirectLocation(response, '/github-app?fromApp=1&github_install=success');
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });

  test('redirects to /github-app fallback for app-initiated pending approval', async () => {
    mockedConsumeInstallState.mockResolvedValue({
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
    mockedConsumeInstallState.mockResolvedValue({
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
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
    mockedConsumeInstallState.mockResolvedValue({
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?fromApp=1&error=installation_already_claimed');
  });

  test('app-initiated missing_installation_id redirects to /github-app fallback', async () => {
    mockedConsumeInstallState.mockResolvedValue({
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
    mockedConsumeInstallState.mockResolvedValue({
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?fromApp=1&error=installation_not_found');
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('app-initiated pending_setup_failed redirects to /github-app fallback', async () => {
    mockedConsumeInstallState.mockResolvedValue({
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
    mockedCreatePending.mockRejectedValue(new Error('DB error') as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=request&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/github-app?fromApp=1&error=pending_setup_failed');
  });

  test('app-initiated org success preserves organizationId on redirect', async () => {
    const ORG_ID = 'org-789';
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({ ok: true });
    mockedConsumeInstallState.mockResolvedValue({
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
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
    mockedConsumeInstallState.mockResolvedValue({
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${DB_TOKEN}`
      ) as never
    );

    expect(response.status).toBe(307);
    // No organizationId for user-scoped install.
    expectRedirectLocation(response, '/github-app?fromApp=1&github_install=success');
  });

  test('app-initiated org pending approval preserves organizationId', async () => {
    const ORG_ID = 'org-pending';
    mockedConsumeInstallState.mockResolvedValue({
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

describe('GET /api/integrations/github/callback legacy flag gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({ ok: true });
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: USER_ID,
        google_user_email: 'mobile-e2e@example.com',
        google_user_name: 'Mobile E2E',
      },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);
    mockedConsumeInstallState.mockResolvedValue(null);
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

  test('accepts legacy org_ prefixed state when flag is enabled', async () => {
    mockedGetEnvVariable.mockReturnValue('true');

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=org_${USER_ID}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      `/organizations/${USER_ID}/integrations/github?success=installed`
    );
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });

  test('refuses legacy org_ prefixed state when flag is disabled', async () => {
    mockedGetEnvVariable.mockReturnValue('false');

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=org_${USER_ID}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/');
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('accepts legacy user_ prefixed state when flag is enabled', async () => {
    mockedGetEnvVariable.mockReturnValue('true');

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?success=installed`);
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });

  test('refuses legacy user_ prefixed state when flag is disabled', async () => {
    mockedGetEnvVariable.mockReturnValue('false');

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/');
    expect(mockedUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
  });

  test('accepts legacy state when flag is unset (default enabled)', async () => {
    mockedGetEnvVariable.mockReturnValue(undefined as unknown as string);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?success=installed`);
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });
});

describe('GET /api/integrations/github/callback admin proof (report mode)', () => {
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
    mockedConsumeInstallState.mockResolvedValue(null);
    mockedGetEnvVariable.mockReturnValue('true');
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
    mockedAssertUserAdministersInstallation.mockResolvedValue(true);
    mockedExchangeGitHubOAuthCode.mockResolvedValue({
      id: GITHUB_USER_ID,
      login: 'octocat',
      accessToken: 'ghu_test-token',
    });
  });

  test('completes an install when code is absent (report mode)', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?success=installed`);
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
    // Admin proof was not run.
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedAssertUserAdministersInstallation).not.toHaveBeenCalled();
  });

  test('completes an install when code is present and user is admin (report mode)', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}&code=abc`
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

  test('still completes install when admin check returns false (report mode does not block non-admin)', async () => {
    mockedAssertUserAdministersInstallation.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}&code=abc`
      ) as never
    );

    // Report mode: non-admin is logged but the install proceeds.
    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?success=installed`);
    expect(mockedExchangeGitHubOAuthCode).toHaveBeenCalled();
    expect(mockedAssertUserAdministersInstallation).toHaveBeenCalled();
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });

  test('still completes install when code exchange fails (report mode)', async () => {
    mockedExchangeGitHubOAuthCode.mockRejectedValue(new Error('Token exchange failed'));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}&code=abc`
      ) as never
    );

    // API failure in admin proof does not block the install.
    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?success=installed`);
    expect(mockedUpsertPlatformIntegrationForOwner).toHaveBeenCalled();
  });

  test('redirects with installation_already_claimed when upsert detects cross-owner claim', async () => {
    mockedUpsertPlatformIntegrationForOwner.mockResolvedValue({
      ok: false,
      reason: 'claimed_by_other_owner',
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}`
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/integrations/github?error=installation_already_claimed`);
  });

  test('logs distinct messages for code-absent vs non-admin (report mode distinguishes)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Case 1: code absent — should log code_absent.
    const { GET } = await import('./route');
    await GET(
      makeRequest(
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}`
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
        `/api/integrations/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=user_${USER_ID}&code=abc`
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
