import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
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
import {
  normalizeInstanceUrl,
  type GitLabIntegrationMetadata,
} from '@/lib/integrations/gitlab-service';
import { resetCodeReviewConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { APP_URL } from '@/lib/constants';
import { createHash, randomBytes } from 'crypto';
import {
  DEFAULT_GITLAB_OAUTH_INSTANCE_URL,
  type VerifiedGitLabOAuthState,
  verifyGitLabOAuthState,
} from '@/lib/integrations/platforms/gitlab/oauth-state';
import { getGitLabOAuthCredentials } from '@/lib/integrations/platforms/gitlab/oauth-credentials';
import {
  type VerifiedGitLabBotLinkState,
  verifyGitLabBotLinkState,
} from '@/lib/bot/gitlab-link-state';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegrationById,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { bot } from '@/lib/bot';
import { linkKiloUser } from '@/lib/bot-identity';

/**
 * Generates a secure random webhook secret for GitLab webhook verification
 */
function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

function htmlPage(title: string, message: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

async function handleGitLabBotLinkCallback(
  request: NextRequest,
  user: { id: string },
  state: VerifiedGitLabBotLinkState
): Promise<Response> {
  const searchParams = request.nextUrl.searchParams;
  const error = searchParams.get('error');
  const code = searchParams.get('code');

  if (error) {
    captureMessage('GitLab bot-link OAuth error', {
      level: 'warning',
      tags: { endpoint: 'gitlab/callback', source: 'gitlab_bot_link' },
      extra: { error },
    });
    return htmlPage(
      'Link Failed',
      'GitLab returned an OAuth error. Please return to GitLab and try again.',
      400
    );
  }

  if (!code) {
    return htmlPage(
      'Link Failed',
      'GitLab did not return an authorization code. Please try again.',
      400
    );
  }

  if (state.userId !== user.id) {
    return htmlPage(
      'Link Failed',
      'This GitLab link request was started by another Kilo user.',
      403
    );
  }

  const integration = await getPlatformIntegrationById(state.platformIntegrationId).catch(
    () => null
  );

  if (!integration || integration.platform !== PLATFORM.GITLAB) {
    return htmlPage('Link Failed', 'No matching GitLab integration was found.', 404);
  }

  if (!botPlatforms.require(PLATFORM.GITLAB).isEnabledForBot(integration)) {
    return htmlPage('Link Unavailable', 'GitLab linking is not enabled for this integration.', 404);
  }

  if (!(await canKiloUserAccessPlatformIntegration(integration, user.id))) {
    return htmlPage('Link Failed', 'You do not have access to this GitLab integration.', 403);
  }

  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const instanceUrl = metadata?.gitlab_instance_url || DEFAULT_GITLAB_OAUTH_INSTANCE_URL;
  const customCredentials =
    metadata?.client_id && metadata.client_secret
      ? { clientId: metadata.client_id, clientSecret: metadata.client_secret }
      : undefined;
  const tokens = await exchangeGitLabOAuthCode(code, instanceUrl, customCredentials);
  const gitlabUser = await fetchGitLabUser(tokens.access_token, instanceUrl);

  await bot.initialize();
  await linkKiloUser(
    bot.getState(),
    {
      platform: PLATFORM.GITLAB,
      teamId: integration.id,
      userId: gitlabUser.id.toString(),
    },
    user.id
  );

  return htmlPage(
    'GitLab account linked',
    `GitLab account ${gitlabUser.username} has been linked to your Kilo account.<br>You can return to GitLab and mention Kilo again.`
  );
}

function buildGitLabRedirectPath(
  state: Pick<VerifiedGitLabOAuthState, 'owner' | 'returnTo'> | null | undefined,
  queryParams: string
): string {
  if (state?.returnTo) {
    return `${state.returnTo}${state.returnTo.includes('?') ? '&' : '?'}${queryParams}`;
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
export async function GET(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    const botLinkState = verifyGitLabBotLinkState(state);
    if (botLinkState) {
      return await handleGitLabBotLinkCallback(request, user, botLinkState);
    }

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

    const tokens = await exchangeGitLabOAuthCode(code, instanceUrl, customCredentials);

    const gitlabUser = await fetchGitLabUser(tokens.access_token, instanceUrl);

    let repositories = null;
    try {
      repositories = await fetchGitLabProjects(tokens.access_token, instanceUrl);
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
        normalizeInstanceUrl(instanceUrl);

    const webhookSecret = isInstanceChange
      ? generateWebhookSecret()
      : ((existingMetadata?.webhook_secret as string | undefined) ?? generateWebhookSecret());

    const metadata: Record<string, unknown> = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: tokenExpiresAt,
      gitlab_instance_url:
        instanceUrl !== DEFAULT_GITLAB_OAUTH_INSTANCE_URL ? instanceUrl : undefined,
      webhook_secret: webhookSecret,
      auth_type: 'oauth',
      bot_enabled: existingMetadata?.bot_enabled === false ? false : true,
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
      ? `${verifiedState.returnTo}${verifiedState.returnTo.includes('?') ? '&' : '?'}success=gitlab_connected`
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
