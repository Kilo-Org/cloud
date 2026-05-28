process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

import { beforeEach, describe, expect, test, jest } from '@jest/globals';
import { GOOGLE_CAPABILITY } from '@/lib/integrations/google/capabilities';

const mockedGetToken =
  jest.fn<() => Promise<{ tokens: { access_token: string; scope: string } }>>();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    getToken: mockedGetToken,
  })),
}));

describe('Google OAuth granted scope validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PORT = '3000';
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID = 'test-google-workspace-client-id';
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = 'test-google-workspace-client-secret';
    process.env.GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI =
      'http://localhost:3000/api/integrations/google/callback';
  });

  test('classifies a refused Calendar capability as an expected permission outcome', async () => {
    mockedGetToken.mockResolvedValue({
      tokens: {
        access_token: 'access-token',
        scope: 'openid https://www.googleapis.com/auth/userinfo.email',
      },
    });

    const { exchangeGoogleOAuthCode, GoogleOAuthCapabilityScopesNotGrantedError } =
      await import('@/lib/integrations/google-service');

    await expect(
      exchangeGoogleOAuthCode('code', [GOOGLE_CAPABILITY.CALENDAR_READ])
    ).rejects.toBeInstanceOf(GoogleOAuthCapabilityScopesNotGrantedError);
  });

  test('keeps missing required identity scopes as an unexpected failure', async () => {
    mockedGetToken.mockResolvedValue({
      tokens: {
        access_token: 'access-token',
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
      },
    });

    const { exchangeGoogleOAuthCode, GoogleOAuthCapabilityScopesNotGrantedError } =
      await import('@/lib/integrations/google-service');

    let error: unknown;
    try {
      await exchangeGoogleOAuthCode('code', [GOOGLE_CAPABILITY.CALENDAR_READ]);
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GoogleOAuthCapabilityScopesNotGrantedError);
    expect((error as Error).message).toBe('Required Google identity scopes were not granted');
  });
});
