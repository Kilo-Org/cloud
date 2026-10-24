import { beforeEach, describe, expect, test } from '@jest/globals';
import { captureMessage } from '@sentry/nextjs';
import { NextRequest } from 'next/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { exchangeDoltHubOAuthCode } from '@/lib/integrations/dolthub-service';
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
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedExchangeDoltHubOAuthCode = jest.mocked(exchangeDoltHubOAuthCode);

const USER_ID = 'e0c2bd2a-4d1e-4c33-9a2f-6f0f2f3a5b11';
const AUTHORIZATION_CODE = 'dolthub-authorization-code';

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
