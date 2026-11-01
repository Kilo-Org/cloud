import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { exchangeLinearOAuthCode } from '@/lib/integrations/linear-service';
import { consumeProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { handleLinearOAuthCallback } from './linear-callback';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'linear-callback-test-secret',
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/integrations/linear-service', () => ({
  exchangeLinearOAuthCode: jest.fn(),
  fetchLinearOAuthIdentity: jest.fn(),
  getConflictingLinearInstallation: jest.fn(),
  LinearWorkspaceAlreadyConnectedError: class LinearWorkspaceAlreadyConnectedError extends Error {},
  revokeLinearToken: jest.fn(),
  upsertLinearInstallation: jest.fn(),
}));
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  beginProviderOAuthAttempt: jest.fn(async () => undefined),
  cancelProviderOAuthAttempt: jest.fn(async () => true),
  consumeProviderOAuthAttempt: jest.fn(async () => true),
}));
jest.mock('@/lib/integrations/oauth/workspace-installation-lock', () => ({
  withWorkspaceInstallationLock: jest.fn(
    async (
      _platform: string,
      _owner: unknown,
      _installationId: string,
      operation: (tx: unknown) => Promise<unknown>
    ) => operation({})
  ),
}));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getAdapter: jest.fn(() => ({ getInstallation: jest.fn(async () => null) })),
    getState: jest.fn(() => ({})),
  },
}));
jest.mock('@/lib/bot-identity', () => ({
  linkKiloUser: jest.fn(),
  unlinkTeamKiloUsers: jest.fn(),
}));
jest.mock('@/lib/bot/platform-helpers', () => ({
  canKiloUserAccessPlatformIntegration: jest.fn(),
  getPlatformIntegrationById: jest.fn(),
}));
jest.mock('@/lib/bot/platforms', () => ({ botPlatforms: {} }));
jest.mock('@/lib/bot/linear-link-state', () => ({
  verifyLinearBotLinkState: jest.fn(() => null),
}));
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test/default-model'),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedConsumeProviderOAuthAttempt = jest.mocked(consumeProviderOAuthAttempt);
const mockedExchangeLinearOAuthCode = jest.mocked(exchangeLinearOAuthCode);
const mockedCaptureMessage = jest.mocked(captureMessage);
const mockedCaptureException = jest.mocked(captureException);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const AUTHORIZATION_CODE = 'linear-authorization-code';

function makeCallbackRequest(query: string) {
  return new NextRequest(`http://localhost:3000/api/integrations/linear/callback?${query}`);
}

function providerInstallState() {
  return createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
    provider: 'linear',
    purpose: 'provider_install',
  });
}

function redirectTarget(response: Response) {
  const url = new URL(response.headers.get('location') ?? '');
  return `${url.pathname}${url.search}`;
}

/** Every captured diagnostic carries the shared callback context and nothing raw. */
function expectRedactedDiagnostic(state: string, code?: string) {
  const calls = [...mockedCaptureMessage.mock.calls, ...mockedCaptureException.mock.calls];
  expect(calls).toHaveLength(1);
  const context = calls[0]![1] as { extra?: Record<string, unknown> };
  expect(context.extra).toEqual(
    expect.objectContaining({
      hasState: true,
      stateHash: expect.stringMatching(/^[0-9a-f]{8}$/),
    })
  );
  expect(context.extra).not.toHaveProperty('state');
  expect(context.extra).not.toHaveProperty('code');
  const serialized = JSON.stringify(context);
  expect(serialized).not.toContain(state);
  if (code) expect(serialized).not.toContain(code);
}

describe('handleLinearOAuthCallback diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedConsumeProviderOAuthAttempt.mockResolvedValue(true);
    jest.mocked(ensureOrganizationAccess).mockResolvedValue('owner');
  });

  test('reports a provider error with the shared callback context', async () => {
    const state = providerInstallState();

    const response = await handleLinearOAuthCallback(
      makeCallbackRequest(`error=access_denied&state=${encodeURIComponent(state)}`)
    );

    expect(redirectTarget(response)).toBe('/integrations/linear?error=access_denied');
    expectRedactedDiagnostic(state);
    expect(mockedCaptureMessage.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        level: 'warning',
        tags: { endpoint: 'linear/callback', source: 'linear_oauth' },
        extra: expect.objectContaining({ error: 'access_denied' }),
      })
    );
  });

  test('reports a missing code with the shared callback context', async () => {
    const state = providerInstallState();

    const response = await handleLinearOAuthCallback(
      makeCallbackRequest(`state=${encodeURIComponent(state)}`)
    );

    expect(redirectTarget(response)).toBe('/integrations/linear?error=missing_code');
    expectRedactedDiagnostic(state);
  });

  test('reports a rejected state signature with the shared callback context', async () => {
    const state = providerInstallState();
    const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;

    const response = await handleLinearOAuthCallback(
      makeCallbackRequest(`code=${AUTHORIZATION_CODE}&state=${encodeURIComponent(tampered)}`)
    );

    expect(redirectTarget(response)).toBe('/integrations?error=invalid_state');
    expectRedactedDiagnostic(tampered, AUTHORIZATION_CODE);
  });

  test('reports an installation failure with the shared callback context', async () => {
    const state = providerInstallState();
    mockedExchangeLinearOAuthCode.mockRejectedValue(new Error('linear exchange failed'));

    const response = await handleLinearOAuthCallback(
      makeCallbackRequest(`code=${AUTHORIZATION_CODE}&state=${encodeURIComponent(state)}`)
    );

    expect(redirectTarget(response)).toBe('/integrations/linear?error=installation_failed');
    expectRedactedDiagnostic(state, AUTHORIZATION_CODE);
  });
});
