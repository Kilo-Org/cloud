import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  exchangeGiteaOAuthCode,
  fetchGiteaUser,
  fetchGiteaRepos,
  calculateTokenExpiry,
} from '@/lib/integrations/platforms/gitea/adapter';
import { normalizeGiteaInstanceUrl } from '@/lib/integrations/platforms/gitea/instance-url';
import { resetCodeReviewConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { createHash } from 'crypto';
import {
  type VerifiedGiteaOAuthState,
  verifyGiteaOAuthState,
} from '@/lib/integrations/platforms/gitea/oauth-state';
import { getGiteaOAuthCredentials } from '@/lib/integrations/platforms/gitea/oauth-credentials';
import {
  appendIntegrationOAuthRedirectQuery,
  organizationAccessDenialErrorCode,
} from '@/lib/integrations/oauth/common';
import { storeGiteaOAuthIntegration } from '@/lib/integrations/platforms/gitea/oauth-integration-writer';
import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';

function buildGiteaRedirectPath(
  state: Pick<VerifiedGiteaOAuthState, 'owner' | 'returnTo'> | null | undefined,
  queryParams: string
): string {
  if (state?.returnTo) {
    return appendIntegrationOAuthRedirectQuery(state.returnTo, queryParams);
  }

  if (state?.owner.type === 'org') {
    return `/organizations/${state.owner.id}/integrations/gitea?${queryParams}`;
  }

  if (state?.owner.type === 'user') {
    return `/integrations/gitea?${queryParams}`;
  }

  return `/integrations?${queryParams}`;
}

function giteaOAuthSentryContext(searchParams: URLSearchParams): {
  hasCode: boolean;
  hasState: boolean;
  stateHash: string | null;
  error: string | null;
  errorDescription: string | null;
} {
  const state = searchParams.get('state');
  return {
    hasCode: !!searchParams.get('code'),
    hasState: !!state,
    stateHash: state ? createHash('sha256').update(state).digest('hex').slice(0, 8) : null,
    error: searchParams.get('error'),
    errorDescription: searchParams.get('error_description'),
  };
}

/**
 * Gitea OAuth Callback
 *
 * Called when user completes the Gitea OAuth authorization flow.
 * Exchanges the authorization code for tokens and stores the integration.
 */
export async function handleGiteaOAuthCallback(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    const verifiedState = verifyGiteaOAuthState(state);
    if (!verifiedState) {
      captureMessage('Gitea callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'gitea/callback', source: 'gitea_oauth' },
        extra: giteaOAuthSentryContext(searchParams),
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    if (verifiedState.userId !== user.id) {
      captureMessage('Gitea callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'gitea/callback', source: 'gitea_oauth' },
        extra: { stateUserId: verifiedState.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    const { owner, instanceUrl, customCredentialsRef } = verifiedState;
    const normalizedInstanceUrl = normalizeGiteaInstanceUrl(instanceUrl);

    if (owner.type === 'org') {
      // Replacing an existing org Gitea integration is a billing-scoped action;
      // a first-time connect keeps member-level access.
      const existingIntegration = await getIntegrationForOrganization(owner.id, PLATFORM.GITEA);
      await ensureOrganizationAccess(
        { user },
        owner.id,
        existingIntegration ? ORGANIZATION_BILLING_ROLES : undefined
      );
    } else if (user.id !== owner.id) {
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    if (error) {
      captureMessage('Gitea OAuth error', {
        level: 'warning',
        tags: { endpoint: 'gitea/callback', source: 'gitea_oauth' },
        extra: giteaOAuthSentryContext(searchParams),
      });

      const redirectPath = buildGiteaRedirectPath(
        verifiedState,
        `error=${encodeURIComponent(error)}`
      );
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    if (!code) {
      captureMessage('Gitea callback missing code', {
        level: 'warning',
        tags: { endpoint: 'gitea/callback', source: 'gitea_oauth' },
        extra: giteaOAuthSentryContext(searchParams),
      });

      const redirectPath = buildGiteaRedirectPath(verifiedState, 'error=missing_code');
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    const customCredentials = customCredentialsRef
      ? ((await getGiteaOAuthCredentials(customCredentialsRef)) ?? undefined)
      : undefined;

    if (customCredentialsRef && !customCredentials) {
      captureMessage('Gitea callback missing cached custom OAuth credentials', {
        level: 'warning',
        tags: { endpoint: 'gitea/callback', source: 'gitea_oauth' },
        extra: giteaOAuthSentryContext(searchParams),
      });

      const redirectPath = buildGiteaRedirectPath(verifiedState, 'error=connection_failed');
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    const tokens = await exchangeGiteaOAuthCode(code, normalizedInstanceUrl, customCredentials);

    const giteaUser = await fetchGiteaUser(tokens.access_token, normalizedInstanceUrl);

    let repositories = null;
    try {
      repositories = await fetchGiteaRepos(tokens.access_token, normalizedInstanceUrl);
    } catch (repoError) {
      // Non-fatal - user can refresh later
      console.error('Failed to fetch Gitea repos:', repoError);
    }

    const tokenExpiresAt = calculateTokenExpiry(tokens.created_at, tokens.expires_in);

    const stored = await storeGiteaOAuthIntegration({
      owner,
      authorizedByUserId: user.id,
      providerBaseUrl: normalizedInstanceUrl,
      providerUser: { id: giteaUser.id.toString(), login: giteaUser.username },
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: tokenExpiresAt,
      oauthClientId: customCredentials?.clientId ?? null,
      oauthClientSecret: customCredentials?.clientSecret ?? null,
      scopes: tokens.scope.split(' '),
      repositories: repositories && repositories.length > 0 ? repositories : null,
    });

    if (stored.instanceChanged) {
      await resetCodeReviewConfigForOwner(owner, PLATFORM.GITEA);
    }

    const successPath = verifiedState.returnTo
      ? appendIntegrationOAuthRedirectQuery(verifiedState.returnTo, 'success=gitea_connected')
      : owner.type === 'org'
      ? `/organizations/${owner.id}/integrations/gitea?success=connected`
      : `/integrations/gitea?success=connected`;

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling Gitea OAuth callback:', error);

    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    const denialCode = organizationAccessDenialErrorCode(error);
    if (!denialCode) {
      captureException(error, {
        tags: {
          endpoint: 'gitea/callback',
          source: 'gitea_oauth',
        },
        extra: giteaOAuthSentryContext(searchParams),
      });
    }

    const redirectPath = buildGiteaRedirectPath(
      verifyGiteaOAuthState(state),
      denialCode ? `error=${denialCode}` : 'error=connection_failed'
    );
    return NextResponse.redirect(new URL(redirectPath, APP_URL));
  }
}
