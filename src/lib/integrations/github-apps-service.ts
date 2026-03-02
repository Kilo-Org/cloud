import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import {
  deleteIntegration,
  findPendingInstallationByKiloUserId,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import {
  deleteGitHubInstallation,
  fetchGitHubBranches,
  fetchGitHubRepositories,
} from '@/lib/integrations/platforms/github/adapter';

/**
 * List all integrations for an owner
 * Only returns GitHub integrations to prevent errors with non-GitHub platforms
 */
export async function listIntegrations(owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, 'github')));

  return integrations;
}

/**
 * Get GitHub App installation status for an owner
 */
export async function getInstallation(owner: Owner): Promise<PlatformIntegration | null> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, 'github')))
    .limit(1);

  return integration || null;
}

/**
 * Check if user has a pending installation in any context
 */
export async function checkUserPendingInstallation(userId: string) {
  const pendingInstallation = await findPendingInstallationByKiloUserId(userId);
  return pendingInstallation;
}

/**
 * Checks if an error indicates the GitHub installation is already gone.
 * This includes:
 * - 404 Not Found: Installation was deleted
 * - 401 Unauthorized: App credentials revoked
 * - 403 Forbidden: App was suspended or access revoked
 */
export function isInstallationGoneError(error: unknown): boolean {
  // Octokit errors have a status property
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;
    return status === 404 || status === 401 || status === 403;
  }
  return false;
}

/**
 * Uninstall GitHub App for an owner
 */
export async function uninstallApp(
  owner: Owner,
  _userId: string,
  _userEmail: string,
  _userName: string
) {
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
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitHub App installation not found',
    });
  }

  if (!integration.platform_installation_id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Installation ID not found',
    });
  }

  // Delete the installation from GitHub
  const appType = integration.github_app_type || 'standard';
  try {
    await deleteGitHubInstallation(integration.platform_installation_id, appType);
  } catch (error) {
    // If the installation is already gone on GitHub (404, 401, 403),
    // proceed to delete from our database anyway
    if (!isInstallationGoneError(error)) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to delete GitHub installation: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // Installation is already gone on GitHub, continue to delete from our database
  }

  // Delete from database
  if (owner.type === 'org') {
    await deleteIntegration(owner.id, 'github');
    // TODO: Add audit log when integration audit actions are defined
  } else {
    // Delete for user
    await db
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.owned_by_user_id, owner.id),
          eq(platform_integrations.platform, 'github')
        )
      );
  }

  return { success: true };
}

/**
 * List repositories accessible by an integration
 * Returns cached repositories by default, fetches fresh from GitHub when forceRefresh is true
 */
export async function listRepositories(
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
    .where(and(eq(platform_integrations.id, integrationId), ownershipCondition))
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Integration not found',
    });
  }

  if (!integration.platform_installation_id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Installation ID not found',
    });
  }

  // If forceRefresh, no cached repos, or never synced before, fetch from GitHub and update cache
  if (forceRefresh || !integration.repositories?.length || !integration.repositories_synced_at) {
    const appType = integration.github_app_type || 'standard';
    const repos = await fetchGitHubRepositories(integration.platform_installation_id, appType);
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
 * Cancel a pending installation
 */
export async function cancelPendingInstallation(owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  // Find the pending installation
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
        isNull(platform_integrations.platform_installation_id)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Pending installation not found',
    });
  }

  // Delete the pending installation record
  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  // TODO: Add audit log when integration audit actions are defined

  return { success: true };
}

/**
 * List branches for a repository accessible by an integration
 * Always fetches fresh from GitHub (no caching)
 */
export async function listBranches(
  owner: Owner,
  integrationId: string,
  repositoryFullName: string
) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(eq(platform_integrations.id, integrationId), ownershipCondition))
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Integration not found',
    });
  }

  if (!integration.platform_installation_id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Installation ID not found',
    });
  }

  const appType = integration.github_app_type || 'standard';
  const branches = await fetchGitHubBranches(
    integration.platform_installation_id,
    repositoryFullName,
    appType
  );

  return { branches };
}
