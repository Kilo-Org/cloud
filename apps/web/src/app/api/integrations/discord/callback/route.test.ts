import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { exchangeDiscordCode, upsertDiscordInstallation } from '@/lib/integrations/discord-service';
import { consumeProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import { handleDiscordOAuthCallback } from '@/lib/integrations/oauth/platforms/discord-callback';
import { createSignedToken } from '@/lib/signed-token';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'discord-callback-test-secret',
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@/lib/integrations/discord-service', () => ({
  exchangeDiscordCode: jest.fn(),
  upsertDiscordInstallation: jest.fn(),
}));
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  consumeProviderOAuthAttempt: jest.fn(async () => true),
  cancelProviderOAuthAttempt: jest.fn(async () => true),
  beginProviderOAuthAttempt: jest.fn(async () => undefined),
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
const mockedExchangeDiscordCode = jest.mocked(exchangeDiscordCode);
const mockedUpsertDiscordInstallation = jest.mocked(upsertDiscordInstallation);
const mockedConsumeProviderOAuthAttempt = jest.mocked(consumeProviderOAuthAttempt);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';

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

describe('handleDiscordOAuthCallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
