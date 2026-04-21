import 'server-only';

import { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
  GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI,
} from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import type { GoogleCapability } from '@/lib/integrations/google/capabilities';
import {
  hasRequiredScopesForCapabilities,
  parseGoogleScopeString,
  resolveGoogleScopesForCapabilities,
} from '@/lib/integrations/google/capabilities';

const GOOGLE_OAUTH_CALLBACK_PATH = '/api/integrations/google/callback';
const EXPECTED_GOOGLE_OAUTH_REDIRECT_URI = `${APP_URL}${GOOGLE_OAUTH_CALLBACK_PATH}`;
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

type GoogleUserInfoResponse = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
};

type GoogleOAuthExchangeResult = {
  refreshToken: string | null;
  grantedScopes: string[];
  googleSubject: string;
  googleEmail: string;
  expiresAt: string | null;
};

export function resolveGoogleOAuthRedirectURI(): string {
  if (!GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI) {
    throw new Error('GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI is not configured');
  }

  if (GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI !== EXPECTED_GOOGLE_OAUTH_REDIRECT_URI) {
    throw new Error(
      `GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI must equal ${EXPECTED_GOOGLE_OAUTH_REDIRECT_URI}`
    );
  }

  return GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI;
}

function createGoogleOAuthClient(): OAuth2Client {
  if (!GOOGLE_WORKSPACE_OAUTH_CLIENT_ID || !GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET) {
    throw new Error('Google Workspace OAuth credentials are not configured');
  }

  const redirectUri = resolveGoogleOAuthRedirectURI();

  return new OAuth2Client({
    clientId: GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
    redirectUri,
  });
}

export function buildGoogleOAuthUrl(
  state: string,
  capabilities: readonly GoogleCapability[]
): string {
  const oauthClient = createGoogleOAuthClient();
  const scopes = resolveGoogleScopesForCapabilities(capabilities);

  return oauthClient.generateAuthUrl({
    state,
    scope: scopes,
    access_type: 'offline',
    include_granted_scopes: false,
    prompt: 'consent',
  });
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfoResponse> {
  const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google userinfo request failed: ${errorText}`);
  }

  return (await response.json()) as GoogleUserInfoResponse;
}

export async function exchangeGoogleOAuthCode(
  code: string,
  requestedCapabilities: readonly GoogleCapability[]
): Promise<GoogleOAuthExchangeResult> {
  const oauthClient = createGoogleOAuthClient();
  const tokenResponse = await oauthClient.getToken({ code });
  const tokens = tokenResponse.tokens;

  if (!tokens.access_token) {
    throw new Error('Google OAuth response did not include an access token');
  }

  const grantedScopesFromToken = parseGoogleScopeString(tokens.scope);
  const grantedScopes =
    grantedScopesFromToken.length > 0
      ? grantedScopesFromToken
      : resolveGoogleScopesForCapabilities(requestedCapabilities);

  if (!hasRequiredScopesForCapabilities(grantedScopes, requestedCapabilities)) {
    throw new Error('Required Google scopes were not granted');
  }

  const userInfo = await fetchGoogleUserInfo(tokens.access_token);
  if (!userInfo.sub || !userInfo.email) {
    throw new Error('Google userinfo response did not include account identity');
  }
  if (userInfo.email_verified === false) {
    throw new Error('Google account email is not verified');
  }

  return {
    refreshToken: tokens.refresh_token ?? null,
    grantedScopes,
    googleSubject: userInfo.sub,
    googleEmail: userInfo.email,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
  };
}
