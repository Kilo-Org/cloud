import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Octokit } from '@octokit/rest';
import { exchangeWebFlowCode } from '@octokit/oauth-methods';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';
import { verifyOAuthState, safeReturnTo } from '@/lib/integrations/platforms/github/oauth-state';
import { db } from '@/lib/drizzle';
import { user_github_app_tokens } from '@kilocode/db/schema';
import { USER_GH_APP_TOKEN_ENCRYPTION_KEY } from '@/lib/config.server';
import { encryptWithSymmetricKey } from '@/lib/encryption';
import { captureException } from '@sentry/nextjs';

type GitHubConnectError =
  | 'exchange_failed'
  | 'access_denied'
  | 'expired_state'
  | 'invalid_state'
  | 'unknown';

function errorRedirect(error: GitHubConnectError, returnTo: string, requestUrl: string): Response {
  const url = new URL(safeReturnTo(returnTo), requestUrl);
  url.searchParams.set('gh_error', error);
  return NextResponse.redirect(url);
}

function mapGitHubError(error: string | null, errorDescription: string | null): GitHubConnectError {
  if (error === 'access_denied') return 'access_denied';
  // Log raw description server-side only
  console.error('GitHub OAuth error:', { error, errorDescription });
  return 'unknown';
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    // 1. Verify state first so we have a return path even on error
    const decoded = verifyOAuthState(state);
    const returnTo = decoded?.return_to ?? '/account/integrations';

    if (error) {
      const mapped = mapGitHubError(error, errorDescription);
      return errorRedirect(mapped, returnTo, request.url);
    }

    if (!decoded) {
      return errorRedirect('invalid_state', returnTo, request.url);
    }

    if (!code) {
      return errorRedirect('exchange_failed', returnTo, request.url);
    }

    const { kilo_user_id, app_type } = decoded;

    // 2. Exchange code for token
    const credentials = getGitHubAppCredentials(app_type);
    const exchangeResult = await exchangeWebFlowCode({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      clientType: 'github-app',
      code,
    });

    if (!exchangeResult.authentication?.token) {
      return errorRedirect('exchange_failed', returnTo, request.url);
    }

    const auth = exchangeResult.authentication;
    const accessToken = auth.token;
    // MVP: ignore refresh token
    const accessTokenExpiresAt =
      'expiresAt' in auth && auth.expiresAt
        ? new Date(auth.expiresAt)
        : new Date(Date.now() + 8 * 60 * 60 * 1000);

    // 3. Resolve identity
    const octokit = new Octokit({ auth: accessToken });
    const { data: githubUser } = await octokit.rest.users.getAuthenticated();

    let primaryEmail: string | null = null;
    try {
      const { data: emails } = await octokit.rest.users.listEmailsForAuthenticatedUser();
      primaryEmail = emails.find(e => e.primary)?.email ?? null;
    } catch {
      // 404 if user keeps emails private — store null
      primaryEmail = null;
    }

    // 4. Encrypt and persist
    const encryptedToken = encryptWithSymmetricKey(accessToken, USER_GH_APP_TOKEN_ENCRYPTION_KEY);

    await db
      .insert(user_github_app_tokens)
      .values({
        kilo_user_id,
        github_app_type: app_type,
        github_user_id: String(githubUser.id),
        github_login: githubUser.login,
        github_email: primaryEmail,
        access_token_encrypted: encryptedToken,
        access_token_expires_at: accessTokenExpiresAt.toISOString(),
        revoked_at: null,
        revocation_reason: null,
      })
      .onConflictDoUpdate({
        target: [user_github_app_tokens.kilo_user_id, user_github_app_tokens.github_app_type],
        set: {
          github_user_id: String(githubUser.id),
          github_login: githubUser.login,
          github_email: primaryEmail,
          access_token_encrypted: encryptedToken,
          access_token_expires_at: accessTokenExpiresAt.toISOString(),
          revoked_at: null,
          revocation_reason: null,
          updated_at: new Date().toISOString(),
        },
      });

    // 5. Redirect back
    const redirectUrl = new URL(safeReturnTo(returnTo), request.url);
    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    console.error('GitHub user-connect callback error:', err);
    captureException(err, {
      tags: { endpoint: 'github/user-connect/callback' },
    });
    // Fallback redirect on unexpected error
    const fallback = new URL('/account/integrations', request.url);
    fallback.searchParams.set('gh_error', 'unknown');
    return NextResponse.redirect(fallback);
  }
}
