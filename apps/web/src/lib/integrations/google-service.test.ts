process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

import { beforeEach, describe, expect, test, jest } from '@jest/globals';
import { GOOGLE_CAPABILITY } from '@/lib/integrations/google/capabilities';

const VALID_REDIRECT_URI = 'http://localhost:3000/api/integrations/google/callback';

describe('google OAuth config hardening', () => {
  beforeEach(() => {
    jest.resetModules();

    process.env.PORT = '3000';
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID = 'test-google-workspace-client-id';
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = 'test-google-workspace-client-secret';
    process.env.GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI = VALID_REDIRECT_URI;
  });

  test('smoke: generated OAuth URL uses the configured redirect URI', async () => {
    const { buildGoogleOAuthUrl } = await import('@/lib/integrations/google-service');

    const oauthUrl = buildGoogleOAuthUrl('state-123', [GOOGLE_CAPABILITY.CALENDAR_READ]);
    const redirectUri = new URL(oauthUrl).searchParams.get('redirect_uri');

    expect(redirectUri).toBe(VALID_REDIRECT_URI);
  });
});
