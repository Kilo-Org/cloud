import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  exchangeGitLabOAuthCode,
  fetchGitLabUser,
  fetchGitLabProjects,
  calculateTokenExpiry,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { normalizeInstanceUrl } from '@/lib/integrations/gitlab-service';
import {
  isDefaultGitLabInstanceUrl,
  normalizeGitLabInstanceUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import { resetCodeReviewConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { APP_URL } from '@/lib/constants';
import { createHash, randomBytes } from 'crypto';
import {
  type VerifiedGitLabOAuthState,
  verifyGitLabOAuthState,
} from '@/lib/integrations/platforms/gitlab/oauth-state';
import { getGitLabOAuthCredentials } from '@/lib/integrations/platforms/gitlab/oauth-credentials';
import { appendIntegrationOAuthRedirectQuery } from '@/lib/integrations/oauth/common';

/**
 * Generates a secure random webhook secret for GitLab webhook verification
 */
function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

function buildGitLabRedirectPath(
  state: Pick<VerifiedGitLabOAuthState, 'owner' | 'returnTo'> | null | undefined,
  queryParams: string
): string {
  if (state?.returnTo) {
    return appendIntegrationOAuthRedirectQuery(state.returnTo, queryParams);
  }

  if (state?.owner.type === 'org') {
    return `/organizations/${state.owner.id}/integrations/gitlab?${queryParams}`;
  }

  if (state?.owner.type === 'user') {
    return `/integrations/gitlab?${queryParams}`;
  }

  return `/integrations?${queryParams}`;
}

function gitLabOAuthSentryContext(searchParams: URLSearchParams): {
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
 * GitLab OAuth Callback
 *
 * Called when user completes the GitLab OAuth authorization flow.
 * Exchanges the authorization code for tokens and stores the integration.
 */
export async function handleGitLabOAuthCallback(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    const verifiedState = verifyGitLabOAuthState(state);
    if (!verifiedState) {
      captureMessage('GitLab callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'gitlab/callback', source: 'gitlab_oauth' },
        extra: gitLabOAuthSentryContext(searchParams),
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    if (verifiedState.userId !== user.id) {
      captureMessage('GitLab callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'gitlab/callback', source: 'gitlab_oauth' },
        extra: { stateUserId: verifiedState.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    const { owner, instanceUrl, customCredentialsRef } = verifiedState;
    const normalizedInstanceUrl = normalizeGitLabInstanceUrl(instanceUrl);

    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id);
    } else if (user.id !== owner.id) {
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    if (error) {
      captureMessage('GitLab OAuth error', {
        level: 'warning',
        tags: { endpoint: 'gitlab/callback', source: 'gitlab_oauth' },
        extra: gitLabOAuthSentryContext(searchParams),
      });

      const redirectPath = buildGitLabRedirectPath(
        verifiedState,
        `error=${encodeURIComponent(error)}`
      );
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    if (!code) {
      captureMessage('GitLab callback missing code', {
        level: 'warning',
        tags: { endpoint: 'gitlab/callback', source: 'gitlab_oauth' },
        extra: gitLabOAuthSentryContext(searchParams),
      });

      const redirectPath = buildGitLabRedirectPath(verifiedState, 'error=missing_code');
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    const customCredentials = customCredentialsRef
      ? ((await getGitLabOAuthCredentials(customCredentialsRef)) ?? undefined)
      : undefined;

    if (customCredentialsRef && !customCredentials) {
      captureMessage('GitLab callback missing cached custom OAuth credentials', {
        level: 'warning',
        tags: { endpoint: 'gitlab/callback', source: 'gitlab_oauth' },
        extra: gitLabOAuthSentryContext(searchParams),
      });

      const redirectPath = buildGitLabRedirectPath(verifiedState, 'error=connection_failed');
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    const tokens = await exchangeGitLabOAuthCode(code, normalizedInstanceUrl, customCredentials);

    const gitlabUser = await fetchGitLabUser(tokens.access_token, normalizedInstanceUrl);

    let repositories = null;
    try {
      repositories = await fetchGitLabProjects(tokens.access_token, normalizedInstanceUrl);
    } catch (repoError) {
      // Non-fatal - user can refresh later
      console.error('Failed to fetch GitLab projects:', repoError);
    }

    const tokenExpiresAt = calculateTokenExpiry(tokens.created_at, tokens.expires_in);

    const ownershipCondition =
      owner.type === 'user'
        ? eq(platform_integrations.owned_by_user_id, owner.id)
        : eq(platform_integrations.owned_by_organization_id, owner.id);

    const [existing] = await db
      .select()
      .from(platform_integrations)
      .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.GITLAB)))
      .limit(1);

    const existingMetadata = existing?.metadata as Record<string, unknown> | null;

    // Detect if the GitLab instance URL changed (e.g. gitlab.com -> self-hosted)
    const isInstanceChange =
      existing !== undefined &&
      normalizeInstanceUrl(existingMetadata?.gitlab_instance_url as string | undefined) !==
        normalizeInstanceUrl(normalizedInstanceUrl);

    const webhookSecret = isInstanceChange
      ? generateWebhookSecret()
      : ((existingMetadata?.webhook_secret as string | undefined) ?? generateWebhookSecret());

    const metadata: Record<string, unknown> = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: tokenExpiresAt,
      gitlab_instance_url: isDefaultGitLabInstanceUrl(normalizedInstanceUrl)
        ? undefined
        : normalizedInstanceUrl,
      webhook_secret: webhookSecret,
      auth_type: 'oauth',
      // Only preserve webhooks/tokens if same instance
      configured_webhooks: isInstanceChange ? undefined : existingMetadata?.configured_webhooks,
      project_tokens: isInstanceChange ? undefined : existingMetadata?.project_tokens,
    };

    if (customCredentials) {
      metadata.client_id = customCredentials.clientId;
      metadata.client_secret = customCredentials.clientSecret;
    }

    if (existing) {
      await db
        .update(platform_integrations)
        .set({
          platform_account_id: gitlabUser.id.toString(),
          platform_account_login: gitlabUser.username,
          scopes: tokens.scope.split(' '),
          integration_status: INTEGRATION_STATUS.ACTIVE,
          repositories: repositories && repositories.length > 0 ? repositories : null,
          metadata,
          updated_at: new Date().toISOString(),
        })
        .where(eq(platform_integrations.id, existing.id));

      // If instance changed, reset the code review agent config
      if (isInstanceChange) {
        await resetCodeReviewConfigForOwner(owner, PLATFORM.GITLAB);
      }
    } else {
      await db.insert(platform_integrations).values({
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        platform: PLATFORM.GITLAB,
        integration_type: 'oauth',
        platform_installation_id: gitlabUser.id.toString(), // Use GitLab user ID as "installation" ID
        platform_account_id: gitlabUser.id.toString(),
        platform_account_login: gitlabUser.username,
        permissions: null, // GitLab OAuth doesn't have granular permissions like GitHub Apps
        scopes: tokens.scope.split(' '),
        repository_access: 'all', // OAuth grants access to all user's projects
        integration_status: INTEGRATION_STATUS.ACTIVE,
        repositories: repositories && repositories.length > 0 ? repositories : null,
        metadata,
        installed_at: new Date().toISOString(),
      });
    }

    const successPath = verifiedState.returnTo
      ? appendIntegrationOAuthRedirectQuery(verifiedState.returnTo, 'success=gitlab_connected')
      : owner.type === 'org'
        ? `/organizations/${owner.id}/integrations/gitlab?success=connected`
        : `/integrations/gitlab?success=connected`;

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling GitLab OAuth callback:', error);

    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    captureException(error, {
      tags: {
        endpoint: 'gitlab/callback',
        source: 'gitlab_oauth',
      },
      extra: gitLabOAuthSentryContext(searchParams),
    });

    const redirectPath = buildGitLabRedirectPath(
      verifyGitLabOAuthState(state),
      'error=connection_failed'
    );
    return NextResponse.redirect(new URL(redirectPath, APP_URL));
  }
}
