import { beforeEach, describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { NextRequest } from 'next/server';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import {
  exchangeDoltHubOAuthCode,
  upsertDoltHubInstallation,
} from '@/lib/integrations/dolthub-service';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { handleDoltHubOAuthCallback } from '@/lib/integrations/oauth/platforms/dolthub-callback';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/integrations/dolthub-service', () => ({
  exchangeDoltHubOAuthCode: jest.fn(),
  upsertDoltHubInstallation: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedCaptureMessage = jest.mocked(captureMessage);
const mockedCaptureException = jest.mocked(captureException);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedExchangeDoltHubOAuthCode = jest.mocked(exchangeDoltHubOAuthCode);
const mockedUpsertDoltHubInstallation = jest.mocked(upsertDoltHubInstallation);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);

const USER_ID = 'e0c2bd2a-4d1e-4c33-9a2f-6f0f2f3a5b11';
const ORGANIZATION_ID = 'org-fixture-for-connect-route-test';
const AUTHORIZATION_CODE = 'dolthub-authorization-code';
const TOKENS = {
  accessToken: 'dolthub-access-token',
  refreshToken: 'dolthub-refresh-token',
  expiresIn: 3600,
  scope: 'api_read_write',
};

function makeRequest(state: string) {
  return new NextRequest(
    `http://localhost:3000/api/integrations/dolthub/callback?code=${encodeURIComponent(AUTHORIZATION_CODE)}&state=${encodeURIComponent(state)}`
  );
}

function capturedDiagnostic() {
  expect(mockedCaptureMessage).toHaveBeenCalledTimes(1);
  const [message, context] = mockedCaptureMessage.mock.calls[0];
  const extra = typeof context === 'object' && 'extra' in context ? context.extra : undefined;
  return { message, extra, serialized: JSON.stringify(context) };
}

function expectInvalidStateRedirect(response: Response) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe('/integrations?error=invalid_state');
}

describe('handleDoltHubOAuthCallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
  });

  test('rejects a state minted for another integration flow', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'github',
    });

    const response = await handleDoltHubOAuthCallback(makeRequest(state));

    expectInvalidStateRedirect(response);
    expect(mockedExchangeDoltHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'DoltHub callback state minted for another flow',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ mintedProvider: 'github' }),
      })
    );
  });

  test('reports the cross-flow rejection with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'github',
    });

    await handleDoltHubOAuthCallback(makeRequest(state));

    const { extra, serialized } = capturedDiagnostic();

    expect(extra).toEqual({
      hasCode: true,
      hasState: true,
      stateHash: expect.stringMatching(/^[0-9a-f]{8}$/),
      hasProviderError: false,
      mintedProvider: 'github',
    });
    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain(AUTHORIZATION_CODE);
  });

  test('reports a rejected state signature with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'dolthub',
    });
    const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;

    const response = await handleDoltHubOAuthCallback(makeRequest(tampered));

    expectInvalidStateRedirect(response);
    expect(mockedExchangeDoltHubOAuthCode).not.toHaveBeenCalled();
    const { message, serialized } = capturedDiagnostic();
    expect(message).toBe('DoltHub callback invalid or tampered state signature');
    expect(serialized).not.toContain(tampered);
    expect(serialized).not.toContain(AUTHORIZATION_CODE);
  });
});

describe('handleDoltHubOAuthCallback owner authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedExchangeDoltHubOAuthCode.mockResolvedValue(TOKENS);
    mockedUpsertDoltHubInstallation.mockResolvedValue({
      id: 'integration-id',
    } as never);
  });

  function redirectPath(response: Response): string {
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    return `${url.pathname}${url.search}`;
  }

  test('an organization connect requires the billing role that governs integrations', async () => {
    const state = createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID, undefined, {
      provider: 'dolthub',
    });

    const response = await handleDoltHubOAuthCallback(makeRequest(state));

    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: USER_ID }) }),
      ORGANIZATION_ID,
      ORGANIZATION_BILLING_ROLES
    );
    expect(mockedUpsertDoltHubInstallation).toHaveBeenCalledWith({
      owner: { type: 'org', id: ORGANIZATION_ID },
      tokens: TOKENS,
    });
    expect(redirectPath(response)).toBe(
      `/organizations/${ORGANIZATION_ID}/integrations/dolthub?success=installed`
    );
  });

  test('a rejected organization role stops before the token exchange and the write', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValueOnce(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      })
    );
    const state = createOAuthState(`org_${ORGANIZATION_ID}`, USER_ID, undefined, {
      provider: 'dolthub',
    });

    const response = await handleDoltHubOAuthCallback(makeRequest(state));

    expect(mockedExchangeDoltHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedUpsertDoltHubInstallation).not.toHaveBeenCalled();
    expect(mockedCaptureException).not.toHaveBeenCalled();
    expect(redirectPath(response)).toBe(
      `/organizations/${ORGANIZATION_ID}/integrations/dolthub?error=permission_required`
    );
  });

  test('a personal connect stays at owner level', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'dolthub',
    });

    const response = await handleDoltHubOAuthCallback(makeRequest(state));

    expect(mockedEnsureOrganizationAccess).not.toHaveBeenCalled();
    expect(mockedUpsertDoltHubInstallation).toHaveBeenCalledWith({
      owner: { type: 'user', id: USER_ID },
      tokens: TOKENS,
    });
    expect(redirectPath(response)).toBe('/integrations/dolthub?success=installed');
  });
});
