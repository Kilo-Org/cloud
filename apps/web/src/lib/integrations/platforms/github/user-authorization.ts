import 'server-only';

import { Octokit } from '@octokit/rest';
import { captureException } from '@sentry/nextjs';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID,
  USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY,
} from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { encryptKeyedEnvelope } from '@/lib/encryption';
import { user_github_app_tokens } from '@kilocode/db/schema';
import { getGitHubAppCredentials, type GitHubAppType } from './app-selector';
import { disconnectStoredGitHubUserAuthorization } from './user-authorization-client';

const GITHUB_USER_TOKEN_ENVELOPE_SCHEME = 'github-user-token-rsa-aes-256-gcm';

const GitHubUserTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().positive(),
});

const GitHubAuthenticatedUserSchema = z.object({
  id: z.number(),
  login: z.string().min(1),
});

type DebugDetail = string | number | boolean;

function logDevelopmentAuthorizationFailure(
  stage: string,
  details: Record<string, DebugDetail> = {}
): void {
  if (process.env.NODE_ENV !== 'development') return;
  console.error('[GitHub user authorization debug]', { stage, ...details });
}

function responseHasProperty(value: unknown, property: string): boolean {
  return typeof value === 'object' && value !== null && property in value;
}

async function withDevelopmentFailureStage<T>(
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logDevelopmentAuthorizationFailure(stage);
    throw error;
  }
}

function requireTokenEnvelopePublicKey(): { keyId: string; publicKeyPem: Buffer } {
  if (!USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID || !USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY) {
    logDevelopmentAuthorizationFailure('missing_token_envelope_public_key');
    throw new Error('GitHub user token envelope encryption is not configured');
  }
  return {
    keyId: USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID,
    publicKeyPem: Buffer.from(USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY, 'base64'),
  };
}

function tokenEnvelopeAad(
  kiloUserId: string,
  githubUserId: string,
  tokenType: 'access' | 'refresh'
): string {
  return `github-user-authorization:v1:${kiloUserId}:standard:${githubUserId}:${tokenType}`;
}

function authorizationGrantLockKey(githubUserId: string): string {
  return `github-user-authorization:standard:${githubUserId}`;
}

async function getAuthenticatedGitHubUser(accessToken: string) {
  const octokit = new Octokit({ auth: accessToken });
  let authenticatedUserResponse: unknown;
  try {
    authenticatedUserResponse = (await octokit.rest.users.getAuthenticated()).data;
  } catch (error) {
    logDevelopmentAuthorizationFailure('authenticated_user_request_failed');
    throw error;
  }
  const authenticatedUser = GitHubAuthenticatedUserSchema.safeParse(authenticatedUserResponse);
  if (!authenticatedUser.success) {
    logDevelopmentAuthorizationFailure('authenticated_user_invalid_response');
    throw new Error('GitHub user authorization returned invalid user identity');
  }
  return authenticatedUser.data;
}

async function exchangeGitHubUserAuthorizationCode(code: string, codeVerifier: string) {
  const credentials = getGitHubAppCredentials('standard');
  if (!credentials.clientId || !credentials.clientSecret) {
    logDevelopmentAuthorizationFailure('missing_app_credentials', {
      hasClientId: Boolean(credentials.clientId),
      hasClientSecret: Boolean(credentials.clientSecret),
    });
    throw new Error('Missing GitHub standard App credentials');
  }

  let response: Response;
  try {
    response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        code_verifier: codeVerifier,
      }),
    });
  } catch (error) {
    logDevelopmentAuthorizationFailure('token_exchange_request_failed');
    throw error;
  }
  if (!response.ok) {
    logDevelopmentAuthorizationFailure('token_exchange_http_error', { status: response.status });
    throw new Error(`GitHub user authorization exchange failed (${response.status})`);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (error) {
    logDevelopmentAuthorizationFailure('token_exchange_invalid_json');
    throw error;
  }
  const parsedTokens = GitHubUserTokenResponseSchema.safeParse(responseBody);
  if (!parsedTokens.success) {
    logDevelopmentAuthorizationFailure('token_exchange_invalid_credentials', {
      hasAccessToken: responseHasProperty(responseBody, 'access_token'),
      hasAccessTokenExpiry: responseHasProperty(responseBody, 'expires_in'),
      hasRefreshToken: responseHasProperty(responseBody, 'refresh_token'),
      hasRefreshTokenExpiry: responseHasProperty(responseBody, 'refresh_token_expires_in'),
    });
    throw new Error('GitHub user authorization exchange returned invalid credentials');
  }

  const authenticatedUser = await getAuthenticatedGitHubUser(parsedTokens.data.access_token);
  return { tokens: parsedTokens.data, user: authenticatedUser };
}

export type StoreGitHubUserAuthorizationResult =
  | { status: 'connected'; githubLogin: string }
  | { status: 'already_connected_to_another_account' }
  | { status: 'disconnect_existing_identity_first' };

export async function exchangeAndStoreGitHubUserAuthorization(input: {
  kiloUserId: string;
  code: string;
  codeVerifier: string;
}): Promise<StoreGitHubUserAuthorizationResult> {
  const { tokens, user } = await exchangeGitHubUserAuthorizationCode(
    input.code,
    input.codeVerifier
  );
  const githubUserId = user.id.toString();

  try {
    return await db.transaction(async tx => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${authorizationGrantLockKey(githubUserId)}))`
      );
      const [existingOwner] = await withDevelopmentFailureStage(
        'existing_owner_lookup_failed',
        () =>
          tx
            .select({ kiloUserId: user_github_app_tokens.kilo_user_id })
            .from(user_github_app_tokens)
            .where(
              and(
                eq(user_github_app_tokens.github_user_id, githubUserId),
                eq(user_github_app_tokens.github_app_type, 'standard')
              )
            )
            .limit(1)
      );
      if (existingOwner && existingOwner.kiloUserId !== input.kiloUserId) {
        return { status: 'already_connected_to_another_account' };
      }

      const currentUser = await getAuthenticatedGitHubUser(tokens.access_token);
      if (currentUser.id.toString() !== githubUserId) {
        throw new Error('GitHub user authorization identity changed during connection');
      }
      const encryptionKey = requireTokenEnvelopePublicKey();
      const now = Date.now();
      let values: typeof user_github_app_tokens.$inferInsert;
      try {
        values = {
          kilo_user_id: input.kiloUserId,
          github_app_type: 'standard',
          github_user_id: githubUserId,
          github_login: currentUser.login,
          access_token_encrypted: encryptKeyedEnvelope(
            tokens.access_token,
            GITHUB_USER_TOKEN_ENVELOPE_SCHEME,
            encryptionKey,
            tokenEnvelopeAad(input.kiloUserId, githubUserId, 'access')
          ),
          access_token_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
          refresh_token_encrypted: encryptKeyedEnvelope(
            tokens.refresh_token,
            GITHUB_USER_TOKEN_ENVELOPE_SCHEME,
            encryptionKey,
            tokenEnvelopeAad(input.kiloUserId, githubUserId, 'refresh')
          ),
          refresh_token_expires_at: new Date(
            now + tokens.refresh_token_expires_in * 1000
          ).toISOString(),
          revoked_at: null,
          revocation_reason: null,
        };
      } catch (error) {
        logDevelopmentAuthorizationFailure('credential_encryption_failed');
        throw error;
      }

      const [storedAuthorization] = await tx
        .insert(user_github_app_tokens)
        .values(values)
        .onConflictDoUpdate({
          target: [user_github_app_tokens.kilo_user_id, user_github_app_tokens.github_app_type],
          set: {
            github_user_id: values.github_user_id,
            github_login: values.github_login,
            access_token_encrypted: values.access_token_encrypted,
            access_token_expires_at: values.access_token_expires_at,
            refresh_token_encrypted: values.refresh_token_encrypted,
            refresh_token_expires_at: values.refresh_token_expires_at,
            revoked_at: null,
            revocation_reason: null,
            credential_version: sql`${user_github_app_tokens.credential_version} + 1`,
            updated_at: new Date().toISOString(),
          },
          setWhere: eq(user_github_app_tokens.github_user_id, githubUserId),
        })
        .returning({ id: user_github_app_tokens.id });
      if (!storedAuthorization) {
        await revokeAuthorizationOnGitHub(tokens.access_token);
        return { status: 'disconnect_existing_identity_first' };
      }
      return { status: 'connected', githubLogin: currentUser.login };
    });
  } catch (error) {
    const [conflict] = await withDevelopmentFailureStage('credential_conflict_lookup_failed', () =>
      db
        .select({ kiloUserId: user_github_app_tokens.kilo_user_id })
        .from(user_github_app_tokens)
        .where(
          and(
            eq(user_github_app_tokens.github_user_id, githubUserId),
            eq(user_github_app_tokens.github_app_type, 'standard')
          )
        )
        .limit(1)
    );
    if (conflict && conflict.kiloUserId !== input.kiloUserId) {
      return { status: 'already_connected_to_another_account' };
    }
    logDevelopmentAuthorizationFailure('credential_persistence_failed');
    throw error;
  }
}

export async function getGitHubUserAuthorizationStatus(kiloUserId: string): Promise<{
  connected: boolean;
  githubLogin: string | null;
  revoked: boolean;
}> {
  const [authorization] = await db
    .select({
      githubLogin: user_github_app_tokens.github_login,
      revokedAt: user_github_app_tokens.revoked_at,
    })
    .from(user_github_app_tokens)
    .where(
      and(
        eq(user_github_app_tokens.kilo_user_id, kiloUserId),
        eq(user_github_app_tokens.github_app_type, 'standard')
      )
    )
    .limit(1);

  return authorization
    ? {
        connected: authorization.revokedAt === null,
        githubLogin: authorization.githubLogin,
        revoked: authorization.revokedAt !== null,
      }
    : { connected: false, githubLogin: null, revoked: false };
}

async function revokeAuthorizationOnGitHub(
  accessToken: string
): Promise<'revoked' | 'token_invalid'> {
  const credentials = getGitHubAppCredentials('standard');
  if (!credentials.clientId || !credentials.clientSecret) return 'token_invalid';
  const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    'base64'
  );
  const response = await fetch(
    `https://api.github.com/applications/${credentials.clientId}/grant`,
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: accessToken }),
    }
  );
  if (response.ok || response.status === 404) return 'revoked';
  if (response.status === 401 || response.status === 403 || response.status === 422) {
    return 'token_invalid';
  }
  throw new Error(`GitHub authorization revocation failed (${response.status})`);
}

export async function disconnectGitHubUserAuthorization(kiloUserId: string): Promise<void> {
  try {
    await disconnectStoredGitHubUserAuthorization(kiloUserId);
  } catch (error) {
    captureException(error, {
      tags: { source: 'github_user_authorization_disconnect' },
    });
    throw error;
  }
}

export async function revokeStoredGitHubUserAuthorization(
  githubUserId: string,
  appType: GitHubAppType,
  reason: string
): Promise<{ kiloUserId: string } | null> {
  if (appType !== 'standard') return null;
  const [authorization] = await db
    .update(user_github_app_tokens)
    .set({ revoked_at: new Date().toISOString(), revocation_reason: reason })
    .where(
      and(
        eq(user_github_app_tokens.github_user_id, githubUserId),
        eq(user_github_app_tokens.github_app_type, 'standard')
      )
    )
    .returning({ kiloUserId: user_github_app_tokens.kilo_user_id });
  return authorization ?? null;
}
