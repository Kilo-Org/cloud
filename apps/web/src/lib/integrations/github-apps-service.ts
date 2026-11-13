import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, asc, desc, isNull, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  requireNumericPlatformRepositories,
  shouldSyncProviderRepositories,
  type Owner,
} from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { platformIntegrationHealthSql } from '@/lib/integrations/core/health';
import {
  findPendingInstallationByKiloUserId,
  getGitHubIntegrationById,
  personalGitHubIntegrationOrder,
  updateIntegrationMetadataForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { uninstallExclusiveGitHubInstallation } from '@/lib/integrations/db/github-installations';
import { ownerCondition } from '@/lib/integrations/db/predicates';
import {
  deleteGitHubInstallation,
  fetchGitHubBranches,
  fetchGitHubRepositories,
} from '@/lib/integrations/platforms/github/adapter';
import { isOrganizationModelUpdateAllowed } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * List all integrations for an owner
 * Only returns GitHub integrations to prevent errors with non-GitHub platforms
 */
export async function listIntegrations(owner: Owner) {
  const ownershipCondition = ownerCondition(owner);

  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, 'github')))
    .orderBy(asc(platform_integrations.created_at), asc(platform_integrations.id));

  return integrations;
}

/**
 * Which of these connections `uninstallApp` can remove upstream, judged by the
 * same rule `uninstallExclusiveGitHubInstallation` applies: a `workflow`-role
 * association whose installation has no other locally connected association.
 * The hub reads this instead of guessing from the list alone, so it never
 * offers a native Disconnect the server would refuse.
 */
export async function listNativelyUninstallableIds(
  integrations: readonly PlatformIntegration[]
): Promise<Set<string>> {
  const candidates = integrations.filter(
    integration =>
      integration.github_connection_role === 'workflow' &&
      integration.platform_installation_id != null
  );
  const installationIds = [
    ...new Set(candidates.map(integration => integration.platform_installation_id as string)),
  ];
  if (installationIds.length === 0) {
    return new Set();
  }

  // Every owner's association can share one installation, so the sibling count
  // is read across the table, exactly as the uninstall transaction does.
  const connected = await db
    .select({
      installationId: platform_integrations.platform_installation_id,
      appType: platform_integrations.github_app_type,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        inArray(platform_integrations.platform_installation_id, installationIds),
        isNull(platform_integrations.github_disconnected_at)
      )
    );

  const countKey = (installationId: string, appType: string | null) =>
    `${installationId}:${appType ?? 'standard'}`;
  const counts = new Map<string, number>();
  for (const row of connected) {
    if (!row.installationId) continue;
    const key = countKey(row.installationId, row.appType);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return new Set(
    candidates
      .filter(
        integration =>
          counts.get(
            countKey(integration.platform_installation_id as string, integration.github_app_type)
          ) === 1
      )
      .map(integration => integration.id)
  );
}

/**
 * Get GitHub App installation status for an owner
 */
export async function getInstallation(owner: Owner): Promise<PlatformIntegration | null> {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, 'github')))
    .orderBy(
      ...(owner.type === 'org'
        ? [
            desc(platformIntegrationHealthSql()),
            asc(platform_integrations.created_at),
            asc(platform_integrations.id),
          ]
        : personalGitHubIntegrationOrder())
    )
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
  integrationId: string | undefined,
  _userId: string,
  _userEmail: string,
  _userName: string
) {
  const integration = integrationId
    ? await getGitHubIntegrationById(owner, integrationId)
    : owner.type === 'user'
      ? await getInstallation(owner)
      : null;

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

  try {
    await uninstallExclusiveGitHubInstallation({
      owner,
      integrationId: integration.id,
      deleteUpstream: async (installationId, appType) => {
        try {
          await deleteGitHubInstallation(installationId, appType);
        } catch (error) {
          if (!isInstallationGoneError(error)) throw error;
        }
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('disconnected locally')) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Disconnect this Kilo connection instead of uninstalling the shared GitHub App',
      });
    }
    errorExceptInTest('Failed to delete GitHub installation', { error });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to delete GitHub installation',
    });
  }

  return { success: true };
}

/**
 * List repositories accessible by an integration
 * Returns the cached snapshot by default, including an empty one that has
 * already synced; reads the provider when the row has no snapshot yet or when
 * forceRefresh is true
 */
export async function listRepositories(
  owner: Owner,
  integrationId: string,
  forceRefresh: boolean = false
) {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITHUB)
      )
    )
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

  const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
  // Answer from the cached snapshot unless the caller forces a sync or the
  // integration has never synced: a synced empty snapshot is the
  // connected-empty state, not a reason to re-query GitHub on every read.
  if (
    shouldSyncProviderRepositories({
      forceRefresh,
      cachedRepositories,
      repositoriesSyncedAt: integration.repositories_synced_at,
    })
  ) {
    const appType = integration.github_app_type || 'standard';
    const repos = await fetchGitHubRepositories(
      integration.platform_installation_id,
      appType,
      integration.id,
      'management'
    );
    await updateRepositoriesForIntegration(integrationId, repos);
    return {
      repositories: repos,
      syncedAt: new Date().toISOString(),
    };
  }

  return {
    repositories: cachedRepositories ?? [],
    syncedAt: integration.repositories_synced_at,
  };
}

/**
 * Cancel one pending installation request.
 *
 * The id is required: a user can hold several pending requests, so the caller
 * must name the row it displayed. An id that is not a pending request for this
 * owner is refused rather than replaced by another matching row.
 */
export async function cancelPendingInstallation(owner: Owner, integrationId: string) {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.id, integrationId),
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
  repositoryFullName: string,
  purpose: 'workflow' | 'agent' = 'workflow'
) {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITHUB)
      )
    )
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
    appType,
    integration.id,
    purpose
  );

  return { branches };
}

/**
 * Update the model for a GitHub App integration.
 * For organization-owned integrations, validates the model against org access policy.
 *
 * `integrationId` targets one specific installation — required for organizations that
 * can have multiple GitHub installations, since `getInstallation` would otherwise just
 * guess one. When omitted, falls back to the owner's single best installation, which
 * covers the personal (single-installation) case.
 */
export async function updateModel(
  owner: Owner,
  modelSlug: string,
  integrationId?: string
): Promise<{ success: boolean; error?: string }> {
  const integration = integrationId
    ? await getGitHubIntegrationById(owner, integrationId)
    : await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No GitHub App installation found' };
  }

  // For org integrations, validate the model against org access policy.
  if (owner.type === 'org') {
    if (!(await isOrganizationModelUpdateAllowed(owner.id, modelSlug))) {
      return { success: false, error: 'Model is not allowed by organization policy' };
    }
  }

  await updateIntegrationMetadataForOwner(
    owner,
    PLATFORM.GITHUB,
    { model_slug: modelSlug },
    integration.id
  );

  return { success: true };
}
