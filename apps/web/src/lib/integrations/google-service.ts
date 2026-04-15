import 'server-only';

import { OAuth2Client } from 'google-auth-library';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
  GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI,
  GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY,
} from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import { encryptWithSymmetricKey } from '@/lib/encryption';
import { platform_integrations } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
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

type UpsertGoogleOAuthIntegrationInput = {
  owner: Owner;
  createdByUserId: string;
  instanceId: string;
  googleSubject: string;
  googleEmail: string;
  grantedScopes: string[];
  capabilities: GoogleCapability[];
  refreshToken: string | null;
};

type GoogleIntegrationMetadata = {
  refresh_token_encrypted?: string;
  refresh_token_updated_at?: string;
  oauth_client_id?: string;
  kiloclaw_instance_id?: string;
  last_consented_at?: string;
  last_scope_change_at?: string;
  granted_capabilities?: GoogleCapability[];
  last_refresh_error?: string | null;
  last_refresh_error_at?: string | null;
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

function getOwnershipConditions(owner: Owner) {
  return owner.type === 'user'
    ? [
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id),
      ]
    : [
        eq(platform_integrations.owned_by_organization_id, owner.id),
        isNull(platform_integrations.owned_by_user_id),
      ];
}

function getPlatformInstallationId(instanceId: string): string {
  return `kiloclaw_instance:${instanceId}`;
}

function normalizeMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  return metadata as Record<string, unknown>;
}

function extractEncryptedRefreshToken(metadata: unknown): string | null {
  const normalized = normalizeMetadata(metadata) as GoogleIntegrationMetadata;
  const encrypted = normalized.refresh_token_encrypted;

  if (!encrypted || typeof encrypted !== 'string') {
    return null;
  }

  return encrypted;
}

function encryptRefreshToken(refreshToken: string): string {
  if (!GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY) {
    throw new Error('GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY is not configured');
  }

  return encryptWithSymmetricKey(refreshToken, GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY);
}

export function buildGoogleOAuthUrl(state: string, capabilities: readonly GoogleCapability[]): string {
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

export async function upsertGoogleOAuthIntegration(
  input: UpsertGoogleOAuthIntegrationInput
): Promise<void> {
  const now = new Date().toISOString();
  const platformInstallationId = getPlatformInstallationId(input.instanceId);

  const [existing] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ...getOwnershipConditions(input.owner),
        eq(platform_integrations.platform, PLATFORM.GOOGLE_WORKSPACE),
        eq(platform_integrations.platform_installation_id, platformInstallationId)
      )
    )
    .limit(1);

  const existingMetadata = normalizeMetadata(existing?.metadata);
  const existingEncryptedRefreshToken = extractEncryptedRefreshToken(existing?.metadata);

  const nextEncryptedRefreshToken = input.refreshToken
    ? encryptRefreshToken(input.refreshToken)
    : existingEncryptedRefreshToken;

  if (!nextEncryptedRefreshToken) {
    throw new Error(
      'Google OAuth response did not include a refresh token and no existing token was found'
    );
  }

  const previousScopes = [...new Set(existing?.scopes ?? [])].sort();
  const nextScopes = [...new Set(input.grantedScopes)].sort();
  const scopesChanged =
    previousScopes.length !== nextScopes.length ||
    previousScopes.some((scope, index) => scope !== nextScopes[index]);

  const metadata: GoogleIntegrationMetadata = {
    ...(existingMetadata as GoogleIntegrationMetadata),
    refresh_token_encrypted: nextEncryptedRefreshToken,
    refresh_token_updated_at:
      input.refreshToken || !existingEncryptedRefreshToken
        ? now
        : (existingMetadata.refresh_token_updated_at as string | undefined),
    oauth_client_id: GOOGLE_WORKSPACE_OAUTH_CLIENT_ID ?? undefined,
    kiloclaw_instance_id: input.instanceId,
    last_consented_at: now,
    last_scope_change_at:
      scopesChanged || !existingMetadata.last_scope_change_at
        ? now
        : (existingMetadata.last_scope_change_at as string),
    granted_capabilities: input.capabilities,
    last_refresh_error: null,
    last_refresh_error_at: null,
  };

  if (existing) {
    await db
      .update(platform_integrations)
      .set({
        platform_account_id: input.googleSubject,
        platform_account_login: input.googleEmail,
        scopes: nextScopes,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata,
        updated_at: now,
      })
      .where(eq(platform_integrations.id, existing.id));

    return;
  }

  await db.insert(platform_integrations).values({
    owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
    owned_by_organization_id: input.owner.type === 'org' ? input.owner.id : null,
    created_by_user_id: input.createdByUserId,
    platform: PLATFORM.GOOGLE_WORKSPACE,
    integration_type: 'oauth',
    platform_installation_id: platformInstallationId,
    platform_account_id: input.googleSubject,
    platform_account_login: input.googleEmail,
    scopes: nextScopes,
    integration_status: INTEGRATION_STATUS.ACTIVE,
    metadata,
    installed_at: now,
  });
}
