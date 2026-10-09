import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  exchangeForgejoOAuthCode,
  fetchForgejoUser,
  fetchForgejoRepos,
  calculateTokenExpiry,
} from '@/lib/integrations/platforms/forgejo/adapter';
import { normalizeForgejoInstanceUrl } from '@/lib/integrations/platforms/forgejo/instance-url';
import { resetCodeReviewConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { createHash } from 'crypto';
import {
  type VerifiedForgejoOAuthState,
  verifyForgejoOAuthState,
} from '@/lib/integrations/platforms/forgejo/oauth-state';
import { getForgejoOAuthCredentials } from '@/lib/integrations/platforms/forgejo/oauth-credentials';
import {
  appendIntegrationOAuthRedirectQuery,
  organizationAccessDenialErrorCode,
} from '@/lib/integrations/oauth/common';
import { storeForgejoOAuthIntegration } from '@/lib/integrations/platforms/forgejo/oauth-integration-writer';
import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';

function buildForgejoRedirectPath(
  state: Pick<VerifiedForgejoOAuthState, 'owner' | 'returnTo'> | null | undefined,
  queryParams: string
): string {
  if (state?.returnTo) {
    return appendIntegrationOAuthRedirectQuery(state.returnTo, queryParams);
  }

  if (state?.owner.type === 'org') {
    return `/organizations/${state.owner.id}/integrations/forgejo?${queryParams}`;
  }

  if (state?.owner.type === 'user') {
    return `/integrations/forgejo?${queryParams}`;
  }

  return `/integrations?${queryParams}`;
}

function forgejoOAuthSentryContext(searchParams: URLSearchParams): {
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
 * Forgejo OAuth Callback
 *
 * Called when user completes the Forgejo OAuth authorization flow.
 * Exchanges the authorization code for tokens and stores the integration.
 */
export async function handleForgejoOAuthCallback(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    const verifiedState = verifyForgejoOAuthState(state);
    if (!verifiedState) {
      captureMessage('Forgejo callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'forgejo/callback', source: 'forgejo_oauth' },
        extra: forgejoOAuthSentryContext(searchParams),
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    if (verifiedState.userId !== user.id) {
      captureMessage('Forgejo callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'forgejo/callback', source: 'forgejo_oauth' },
        extra: { stateUserId: verifiedState.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    const { owner, instanceUrl, customCredentialsRef } = verifiedState;
    const normalizedInstanceUrl = normalizeForgejoInstanceUrl(instanceUrl);

    if (owner.type === 'org') {
      // Replacing an existing org Forgejo integration is a billing-scoped action;
      // a first-time connect keeps member-level access.
      const existingIntegration = await getIntegrationForOrganization(
        owner.id,
        PLATFORM.FORGEJO
      );
      await ensureOrganizationAccess(
        { user },
        owner.id,
        existingIntegration ? ORGANIZATION_BILLING_ROLES : undefined
      );
    } else if (user.id !== owner.id) {
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    if (error) {
      captureMessage('Forgejo OAuth error', {
        level: 'warning',
        tags: { endpoint: 'forgejo/callback', source: 'forgejo_oauth' },
        extra: forgejoOAuthSentryContext(searchParams),
      });

      const redirectPath = buildForgejoRedirectPath(
        verifiedState,
        `error=${encodeURIComponent(error)}`
      );
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    if (!code) {
      captureMessage('Forgejo callback missing code', {
        level: 'warning',
        tags: { endpoint: 'forgejo/callback', source: 'forgejo_oauth' },
        extra: forgejoOAuthSentryContext(searchParams),
      });

      const redirectPath = buildForgejoRedirectPath(verifiedState, 'error=missing_code');
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    const customCredentials = customCredentialsRef
      ? ((await getForgejoOAuthCredentials(customCredentialsRef)) ?? undefined)
      : undefined;

    if (customCredentialsRef && !customCredentials) {
      captureMessage('Forgejo callback missing cached custom OAuth credentials', {
        level: 'warning',
        tags: { endpoint: 'forgejo/callback', source: 'forgejo_oauth' },
        extra: forgejoOAuthSentryContext(searchParams),
      });

      const redirectPath = buildForgejoRedirectPath(verifiedState, 'error=connection_failed');
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    const tokens = await exchangeForgejoOAuthCode(
      code,
      normalizedInstanceUrl,
      customCredentials
    );

    const forgejoUser = await fetchForgejoUser(tokens.access_token, normalizedInstanceUrl);

    let repositories = null;
    try {
      repositories = await fetchForgejoRepos(tokens.access_token, normalizedInstanceUrl);
    } catch (repoError) {
      // Non-fatal - user can refresh later
      console.error('Failed to fetch Forgejo repos:', repoError);
    }

    const tokenExpiresAt = calculateTokenExpiry(tokens.created_at, tokens.expires_in);

    const stored = await storeForgejoOAuthIntegration({
      owner,
      authorizedByUserId: user.id,
      providerBaseUrl: normalizedInstanceUrl,
      providerUser: { id: forgejoUser.id.toString(), login: forgejoUser.username },
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: tokenExpiresAt,
      oauthClientId: customCredentials?.clientId ?? null,
      oauthClientSecret: customCredentials?.clientSecret ?? null,
      scopes: tokens.scope.split(' '),
      repositories: repositories && repositories.length > 0 ? repositories : null,
    });

    if (stored.instanceChanged) {
      await resetCodeReviewConfigForOwner(owner, PLATFORM.FORGEJO);
    }

    const successPath = verifiedState.returnTo
      ? appendIntegrationOAuthRedirectQuery(verifiedState.returnTo, 'success=forgejo_connected')
      : owner.type === 'org'
      ? `/organizations/${owner.id}/integrations/forgejo?success=connected`
      : `/integrations/forgejo?success=connected`;

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling Forgejo OAuth callback:', error);

    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    const denialCode = organizationAccessDenialErrorCode(error);
    if (!denialCode) {
      captureException(error, {
        tags: {
          endpoint: 'forgejo/callback',
          source: 'forgejo_oauth',
        },
        extra: forgejoOAuthSentryContext(searchParams),
      });
    }

    const redirectPath = buildForgejoRedirectPath(
      verifyForgejoOAuthState(state),
      denialCode ? `error=${denialCode}` : 'error=connection_failed'
    );
    return NextResponse.redirect(new URL(redirectPath, APP_URL));
  }
}
