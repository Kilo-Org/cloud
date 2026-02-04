import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@/db/schema';
import { platform_integrations } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { updateRepositoriesForIntegration } from '@/lib/integrations/db/platform-integrations';
import {
  fetchGitLabProjects,
  fetchGitLabBranches,
  refreshGitLabOAuthToken,
  isTokenExpired,
  calculateTokenExpiry,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { randomBytes } from 'crypto';

/**
 * GitLab Integration Service
 *
 * Provides business logic for GitLab OAuth integrations.
 * Handles token refresh, repository listing, and integration management.
 */

/**
 * Get GitLab integration for an owner
 */
export async function getGitLabIntegration(owner: Owner): Promise<PlatformIntegration | null> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.GITLAB)))
    .limit(1);

  return integration || null;
}

/**
 * Get a valid access token for a GitLab integration
 * Automatically refreshes the token if expired
 *
 * @param integration - The GitLab integration record
 * @returns Valid access token
 */
export async function getValidGitLabToken(integration: PlatformIntegration): Promise<string> {
  const metadata = integration.metadata as {
    access_token?: string;
    refresh_token?: string;
    token_expires_at?: string;
    gitlab_instance_url?: string;
    client_id?: string;
    client_secret?: string;
  } | null;

  if (!metadata?.access_token) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'GitLab integration missing access token',
    });
  }

  if (metadata.token_expires_at && isTokenExpired(metadata.token_expires_at)) {
    if (!metadata.refresh_token) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitLab token expired and no refresh token available. Please reconnect.',
      });
    }

    const instanceUrl = metadata.gitlab_instance_url || 'https://gitlab.com';

    const customCredentials =
      metadata.client_id && metadata.client_secret
        ? { clientId: metadata.client_id, clientSecret: metadata.client_secret }
        : undefined;

    const newTokens = await refreshGitLabOAuthToken(
      metadata.refresh_token,
      instanceUrl,
      customCredentials
    );

    const newExpiresAt = calculateTokenExpiry(newTokens.created_at, newTokens.expires_in);

    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...metadata,
          access_token: newTokens.access_token,
          refresh_token: newTokens.refresh_token,
          token_expires_at: newExpiresAt,
        },
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));

    return newTokens.access_token;
  }

  return metadata.access_token;
}

/**
 * List repositories accessible by a GitLab integration
 * Returns cached repositories by default, fetches fresh from GitLab when forceRefresh is true
 */
export async function listGitLabRepositories(
  owner: Owner,
  integrationId: string,
  forceRefresh: boolean = false
) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  // If forceRefresh, no cached repos, or never synced before, fetch from GitLab and update cache
  if (forceRefresh || !integration.repositories?.length || !integration.repositories_synced_at) {
    const accessToken = await getValidGitLabToken(integration);
    const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
    const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

    const repos = await fetchGitLabProjects(accessToken, instanceUrl);
    await updateRepositoriesForIntegration(integrationId, repos);

    return {
      repositories: repos,
      syncedAt: new Date().toISOString(),
    };
  }

  // Return cached repos
  return {
    repositories: integration.repositories,
    syncedAt: integration.repositories_synced_at,
  };
}

/**
 * List branches for a GitLab project
 * Always fetches fresh from GitLab (no caching)
 */
export async function listGitLabBranches(
  owner: Owner,
  integrationId: string,
  projectPath: string // e.g., "group/project" or project ID
) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  const accessToken = await getValidGitLabToken(integration);
  const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
  const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

  const branches = await fetchGitLabBranches(accessToken, projectPath, instanceUrl);

  return {
    branches: branches.map(b => ({
      name: b.name,
      isDefault: b.default,
    })),
  };
}

/**
 * Disconnect GitLab integration for an owner
 */
export async function disconnectGitLabIntegration(owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  // Get the integration
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  // Delete from database
  // Note: Unlike GitHub Apps, we don't need to call GitLab API to revoke
  // The OAuth token will simply expire or user can revoke from GitLab settings
  await db
    .delete(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.GITLAB)));

  return { success: true };
}

/**
 * Regenerate webhook secret for a GitLab integration
 * This is useful when the user has lost the webhook secret and needs to reconfigure
 * their GitLab webhook settings
 */
export async function regenerateWebhookSecret(owner: Owner): Promise<{ webhookSecret: string }> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  // Get the integration
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  // Generate new webhook secret
  const newWebhookSecret = randomBytes(32).toString('hex');

  // Update the metadata with the new webhook secret
  const existingMetadata = (integration.metadata || {}) as Record<string, unknown>;
  const updatedMetadata = {
    ...existingMetadata,
    webhook_secret: newWebhookSecret,
  };

  await db
    .update(platform_integrations)
    .set({
      metadata: updatedMetadata,
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integration.id));

  return { webhookSecret: newWebhookSecret };
}
