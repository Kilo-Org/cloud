import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  exchangeGitLabOAuthCode,
  fetchGitLabUser,
  fetchGitLabProjects,
  calculateTokenExpiry,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { APP_URL } from '@/lib/constants';
import { randomBytes } from 'crypto';

/**
 * Generates a secure random webhook secret for GitLab webhook verification
 */
function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
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
    const state = searchParams.get('state'); // Contains owner info (org_ID or user_ID) and optional instance URL
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (error) {
      captureMessage('GitLab OAuth error', {
        level: 'warning',
        tags: { endpoint: 'gitlab/callback', source: 'gitlab_oauth' },
        extra: { error, errorDescription, state },
      });

      const redirectPath = parseRedirectPath(state, `error=${error}`);
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    if (!code) {
      captureMessage('GitLab callback missing code', {
        level: 'warning',
        tags: { endpoint: 'gitlab/callback', source: 'gitlab_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });

      const redirectPath = parseRedirectPath(state, 'error=missing_code');
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    // State format: "org_xxx" or "user_xxx" or "org_xxx|instance_url" or "org_xxx|instance_url|creds:base64"
    const { owner, instanceUrl, customCredentials } = parseState(state);

    if (!owner) {
      captureMessage('GitLab callback missing or invalid owner in state', {
        level: 'warning',
        tags: { endpoint: 'gitlab/callback', source: 'gitlab_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(new URL('/', APP_URL));
    }

    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id);
    } else {
      if (user.id !== owner.id) {
        return NextResponse.redirect(new URL('/', APP_URL));
      }
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
    const webhookSecret = existingMetadata?.webhook_secret ?? generateWebhookSecret();

    // TODO: Implement token/credential encryption?
    const metadata: Record<string, unknown> = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: tokenExpiresAt,
      gitlab_instance_url: instanceUrl !== 'https://gitlab.com' ? instanceUrl : undefined,
      webhook_secret: webhookSecret, // For GitLab webhook verification
      auth_type: 'oauth', // Track authentication method
      configured_webhooks: existingMetadata?.configured_webhooks,
      project_tokens: existingMetadata?.project_tokens,
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

    const successPath =
      owner.type === 'org'
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
      extra: {
        code: searchParams.get('code') ? '[REDACTED]' : null,
        state,
      },
    });

    const redirectPath = parseRedirectPath(state, 'error=connection_failed');
    return NextResponse.redirect(new URL(redirectPath, APP_URL));
  }
}

/**
 * Parses the state parameter to extract owner, optional instance URL, and custom credentials
 *
 * State format:
 * - "org_xxx" - Organization-owned integration on gitlab.com
 * - "user_xxx" - User-owned integration on gitlab.com
 * - "org_xxx|https://gitlab.example.com" - Organization-owned on self-hosted
 * - "org_xxx|https://gitlab.example.com|creds:base64" - Self-hosted with custom credentials
 */
function parseState(state: string | null): {
  owner: Owner | null;
  instanceUrl: string;
  customCredentials?: { clientId: string; clientSecret: string };
} {
  const DEFAULT_INSTANCE = 'https://gitlab.com';

  if (!state) {
    return { owner: null, instanceUrl: DEFAULT_INSTANCE };
  }

  const parts = state.split('|');
  const ownerPart = parts[0];
  let instanceUrl = DEFAULT_INSTANCE;
  let customCredentials: { clientId: string; clientSecret: string } | undefined;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('creds:')) {
      try {
        const encoded = part.replace('creds:', '');
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
        const [clientId, clientSecret] = decoded.split(':');
        if (clientId && clientSecret) {
          customCredentials = { clientId, clientSecret };
        }
      } catch (e) {
        console.error('Failed to decode credentials from state:', e);
      }
    } else if (part.startsWith('http')) {
      instanceUrl = part;
    }
  }

  if (ownerPart.startsWith('org_')) {
    return {
      owner: { type: 'org', id: ownerPart.replace('org_', '') },
      instanceUrl,
      customCredentials,
    };
  } else if (ownerPart.startsWith('user_')) {
    return {
      owner: { type: 'user', id: ownerPart.replace('user_', '') },
      instanceUrl,
      customCredentials,
    };
  }

  return { owner: null, instanceUrl, customCredentials };
}

/**
 * Determines the redirect path based on state parameter
 */
function parseRedirectPath(state: string | null, queryParams: string): string {
  if (!state) {
    return `/?${queryParams}`;
  }

  const [ownerPart] = state.split('|');

  if (ownerPart.startsWith('org_')) {
    const orgId = ownerPart.replace('org_', '');
    return `/organizations/${orgId}/integrations/gitlab?${queryParams}`;
  } else if (ownerPart.startsWith('user_')) {
    return `/integrations/gitlab?${queryParams}`;
  }

  return `/?${queryParams}`;
}
