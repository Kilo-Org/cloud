import { beforeEach, describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { NextRequest } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import {
  DiscordGuildAlreadyConnectedError,
  exchangeDiscordCode,
  upsertDiscordInstallation,
} from '@/lib/integrations/discord-service';
import { withWorkspaceInstallationLock } from '@/lib/integrations/oauth/workspace-installation-lock';
import { consumeProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import { handleDiscordOAuthCallback } from '@/lib/integrations/oauth/platforms/discord-callback';
import { createSignedToken } from '@/lib/signed-token';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'discord-callback-test-secret',
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@/lib/integrations/discord-service', () => {
  class DiscordGuildAlreadyConnectedError extends Error {}
  return {
    DiscordGuildAlreadyConnectedError,
    exchangeDiscordCode: jest.fn(),
    upsertDiscordInstallation: jest.fn(),
  };
});
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
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  consumeProviderOAuthAttempt: jest.fn(async () => true),
  cancelProviderOAuthAttempt: jest.fn(async () => true),
  beginProviderOAuthAttempt: jest.fn(async () => undefined),
}));
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test/default-model'),
}));
jest.mock('@/lib/bot', () => ({
  bot: { initialize: jest.fn(async () => undefined), getAdapter: jest.fn() },
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockedExchangeDiscordCode = jest.mocked(exchangeDiscordCode);
const mockedUpsertDiscordInstallation = jest.mocked(upsertDiscordInstallation);
const mockedConsumeProviderOAuthAttempt = jest.mocked(consumeProviderOAuthAttempt);
const mockedWithWorkspaceInstallationLock = jest.mocked(withWorkspaceInstallationLock);
const mockedCaptureMessage = jest.mocked(captureMessage);
const mockedCaptureException = jest.mocked(captureException);

const GUILD_ID = '123456789012345678';

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORGANIZATION_ID = '9a1f56f0-6a52-4c1f-9f5d-0b0f7f2e6ad4';

function makeRequest(state: string) {
  return new NextRequest(
    `http://localhost:3000/api/integrations/discord/callback?code=authorization-code&state=${encodeURIComponent(state)}`
  );
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

function callDiscordCallback(request: NextRequest) {
  return handleDiscordOAuthCallback(request);
}

function makeCallbackRequest(query: string) {
  return new NextRequest(`http://localhost:3000/api/integrations/discord/callback?${query}`);
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

describe('handleDiscordOAuthCallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedEnsureOrganizationAccess.mockResolvedValue('billing_manager');
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedExchangeDiscordCode.mockResolvedValue({
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: 604800,
      refresh_token: 'refresh-token',
      scope: 'bot applications.commands',
      guild: { id: GUILD_ID, name: 'Test Server', icon: null },
    });
    mockedUpsertDiscordInstallation.mockResolvedValue(undefined as never);
  });

  test('installs with a fresh provider-install state', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(response, '/integrations/discord?success=installed');
    expect(mockedConsumeProviderOAuthAttempt).toHaveBeenCalledTimes(1);
    expect(mockedExchangeDiscordCode).toHaveBeenCalledTimes(1);
    expect(mockedUpsertDiscordInstallation).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      expect.objectContaining({ access_token: 'access-token' }),
      { allowGuildRebind: false, defaultModel: undefined },
      expect.anything()
    );
    expect(mockedWithWorkspaceInstallationLock).toHaveBeenCalledWith(
      'discord',
      { type: 'user', id: USER_ID },
      GUILD_ID,
      expect.any(Function)
    );
    expect(mockedEnsureOrganizationAccess).not.toHaveBeenCalled();
  });

  test('refuses an organization install for a member without the integration role', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      })
    );
    const state = createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(
      response,
      `/organizations/${ORGANIZATION_ID}/integrations/discord?error=permission_required`
    );
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: expect.objectContaining({ id: USER_ID }) },
      ORGANIZATION_ID,
      ORGANIZATION_BILLING_ROLES
    );
    expect(mockedConsumeProviderOAuthAttempt).not.toHaveBeenCalled();
    expect(mockedExchangeDiscordCode).not.toHaveBeenCalled();
    expect(mockedUpsertDiscordInstallation).not.toHaveBeenCalled();
  });

  test('refuses an organization install for a caller outside the organization', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      })
    );
    const state = createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(
      response,
      `/organizations/${ORGANIZATION_ID}/integrations/discord?error=organization_access_required`
    );
    expect(mockedUpsertDiscordInstallation).not.toHaveBeenCalled();
  });

  test('updates an organization installation with the authority that permits a server change', async () => {
    const state = createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(
      response,
      `/organizations/${ORGANIZATION_ID}/integrations/discord?success=installed`
    );
    expect(mockedUpsertDiscordInstallation).toHaveBeenCalledWith(
      { type: 'org', id: ORGANIZATION_ID },
      expect.objectContaining({ access_token: 'access-token' }),
      { allowGuildRebind: true, defaultModel: 'test/default-model' },
      expect.anything()
    );
  });

  test('reports a server connected to another account without a second install', async () => {
    mockedUpsertDiscordInstallation.mockRejectedValue(
      new DiscordGuildAlreadyConnectedError('Some Server')
    );
    const state = createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(
      response,
      `/organizations/${ORGANIZATION_ID}/integrations/discord?error=workspace_already_connected`
    );
    expect(mockedUpsertDiscordInstallation).toHaveBeenCalledTimes(1);
  });

  test('rejects a state minted for another provider', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'bitbucket',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(response, '/integrations?error=invalid_state');
    expect(mockedConsumeProviderOAuthAttempt).not.toHaveBeenCalled();
    expect(mockedExchangeDiscordCode).not.toHaveBeenCalled();
    expect(mockedUpsertDiscordInstallation).not.toHaveBeenCalled();
  });

  test('rejects a state minted without the provider-install purpose', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'discord',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(response, '/integrations?error=invalid_state');
    expect(mockedConsumeProviderOAuthAttempt).not.toHaveBeenCalled();
    expect(mockedExchangeDiscordCode).not.toHaveBeenCalled();
    expect(mockedUpsertDiscordInstallation).not.toHaveBeenCalled();
  });

  test('rejects a signed state payload without a provider claim', async () => {
    const state = createSignedToken({
      owner: `user_${USER_ID}`,
      uid: USER_ID,
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(response, '/integrations?error=invalid_state');
    expect(mockedConsumeProviderOAuthAttempt).not.toHaveBeenCalled();
    expect(mockedExchangeDiscordCode).not.toHaveBeenCalled();
    expect(mockedUpsertDiscordInstallation).not.toHaveBeenCalled();
  });

  test('rejects a provider-install state whose attempt was already consumed', async () => {
    mockedConsumeProviderOAuthAttempt.mockResolvedValue(false);
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(response, '/integrations/discord?error=installation_failed');
    expect(mockedConsumeProviderOAuthAttempt).toHaveBeenCalledTimes(1);
    expect(mockedExchangeDiscordCode).not.toHaveBeenCalled();
    expect(mockedUpsertDiscordInstallation).not.toHaveBeenCalled();
  });

  test('reports a provider error with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(
      makeCallbackRequest(`error=access_denied&state=${encodeURIComponent(state)}`)
    );

    expectRedirectLocation(response, '/integrations/discord?error=access_denied');
    expectRedactedDiagnostic(state);
    expect(mockedCaptureMessage.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ extra: expect.objectContaining({ error: 'access_denied' }) })
    );
  });

  test('reports a missing code with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });

    const response = await callDiscordCallback(
      makeCallbackRequest(`state=${encodeURIComponent(state)}`)
    );

    expectRedirectLocation(response, '/integrations/discord?error=missing_code');
    expectRedactedDiagnostic(state);
  });

  test('reports a rejected state signature with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });
    const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;

    const response = await callDiscordCallback(
      makeCallbackRequest(`code=authorization-code&state=${encodeURIComponent(tampered)}`)
    );

    expectRedirectLocation(response, '/integrations?error=invalid_state');
    expectRedactedDiagnostic(tampered, 'authorization-code');
  });

  test('reports an installation failure with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'discord',
      purpose: 'provider_install',
    });
    mockedExchangeDiscordCode.mockRejectedValue(new Error('discord exchange failed'));

    const response = await callDiscordCallback(makeRequest(state));

    expectRedirectLocation(response, '/integrations/discord?error=installation_failed');
    expectRedactedDiagnostic(state, 'authorization-code');
  });
});
