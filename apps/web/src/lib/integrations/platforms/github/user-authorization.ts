import 'server-only';

import { Octokit } from '@octokit/rest';
import { captureException } from '@sentry/nextjs';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, user_github_app_tokens } from '@kilocode/db/schema';
import { getGitHubAppCredentials, type GitHubAppType } from './app-selector';
import { disconnectStoredGitHubUserAuthorization } from './user-authorization-client';
import { evictGitHubUserAccessTokenCache } from './user-token-client';
import { encryptUserGithubTokenEnvelope } from './user-token-envelope';
import { storeGitHubIdentity } from './identity-store';
import {
  GitHubIdentityConflictError,
  isExpiredProvidedToken,
  type GitHubIdentityPrecondition,
} from '@kilocode/db/github-identity';

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

async function getAuthenticatedGitHubUser(accessToken: string) {
  const octokit = new Octokit({ auth: accessToken, request: { timeout: 10_000 } });
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
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
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

export async function exchangeAndStoreGitHubUserAuthorization(input: {
  kiloUserId: string;
  code: string;
  codeVerifier: string;
  expected: GitHubIdentityPrecondition;
}) {
  const { tokens, user } = await exchangeGitHubUserAuthorizationCode(
    input.code,
    input.codeVerifier
  );
  const githubUserId = user.id.toString();
  const now = Date.now();
  const result = await storeGitHubIdentity(
    {
      kilo_user_id: input.kiloUserId,
      github_app_type: 'standard',
      credential_source: 'github_app',
      github_user_id: githubUserId,
      github_login: user.login,
      access_token_encrypted: encryptUserGithubTokenEnvelope(tokens.access_token, {
        kiloUserId: input.kiloUserId,
        githubUserId,
        tokenType: 'access',
      }),
      access_token_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
      refresh_token_encrypted: encryptUserGithubTokenEnvelope(tokens.refresh_token, {
        kiloUserId: input.kiloUserId,
        githubUserId,
        tokenType: 'refresh',
      }),
      refresh_token_expires_at: new Date(
        now + tokens.refresh_token_expires_in * 1000
      ).toISOString(),
    },
    input.expected,
    async () => {
      const current = await getAuthenticatedGitHubUser(tokens.access_token);
      if (current.id !== user.id) throw new Error('GitHub authorization identity changed');
    }
  );
  if (result.status === 'disconnect_existing_identity_first') {
    // This rejected App grant belongs to a different GitHub account. Never
    // revoke a grant already owned by another Kilo user or a provided token.
    const credentials = getGitHubAppCredentials('standard');
    if (credentials.clientId && credentials.clientSecret) {
      const response = await fetch(
        `https://api.github.com/applications/${credentials.clientId}/grant`,
        {
          method: 'DELETE',
          signal: AbortSignal.timeout(10_000),
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ access_token: tokens.access_token }),
        }
      );
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok && ![401, 403, 404, 422].includes(response.status))
        throw new Error('GitHub authorization revocation failed');
    }
  }
  return result;
}

export async function getGitHubUserAuthorizationStatus(kiloUserId: string) {
  const [row] = await db
    .select({
      authorizationId: user_github_app_tokens.id,
      credentialVersion: user_github_app_tokens.credential_version,
      githubLogin: user_github_app_tokens.github_login,
      revokedAt: user_github_app_tokens.revoked_at,
      credentialSource: user_github_app_tokens.credential_source,
      expiresAt: user_github_app_tokens.access_token_expires_at,
    })
    .from(kilocode_users)
    .leftJoin(
      user_github_app_tokens,
      and(
        eq(user_github_app_tokens.kilo_user_id, kilocode_users.id),
        eq(user_github_app_tokens.github_app_type, 'standard')
      )
    )
    .where(eq(kilocode_users.id, kiloUserId))
    .limit(1);
  if (!row) throw new Error('github_identity_unavailable');
  const expired = isExpiredProvidedToken(row.credentialSource, row.expiresAt);
  return {
    ...row,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    connected: row.authorizationId !== null && row.revokedAt === null && !expired,
    revoked: row.revokedAt !== null || expired,
  };
}

export async function disconnectGitHubUserAuthorization(
  kiloUserId: string,
  expected: GitHubIdentityPrecondition
): Promise<void> {
  try {
    await disconnectStoredGitHubUserAuthorization(kiloUserId, expected);
  } catch (error) {
    // A stale precondition is an expected outcome. The user reloads and retries.
    if (!(error instanceof GitHubIdentityConflictError)) {
      captureException(error, {
        tags: { source: 'github_user_authorization_disconnect' },
      });
    }
    throw error;
  } finally {
    // The authorization may be gone even when the disconnect request failed
    // partway, so the local cache entry is never trusted afterwards.
    evictGitHubUserAccessTokenCache(kiloUserId);
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
        eq(user_github_app_tokens.github_app_type, 'standard'),
        eq(user_github_app_tokens.credential_source, 'github_app')
      )
    )
    .returning({ kiloUserId: user_github_app_tokens.kilo_user_id });
  if (!authorization) return null;
  evictGitHubUserAccessTokenCache(authorization.kiloUserId);
  return authorization;
}
