import { db } from '@/lib/drizzle';
import { platform_integrations } from '@/db/schema';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import type {
  GitHubRequester,
  IntegrationPermissions,
  KiloRequester,
  Owner,
  PlatformRepository,
} from '../core/types';
import { INTEGRATION_STATUS, PLATFORM, PENDING_APPROVAL_STATUS } from '../core/constants';
import type { IntegrationStatus } from '../core/constants';
import { PendingInstallationMetadataWrapperSchema } from '../core/schemas';
import type { GitHubAppType } from '../platforms/github/app-selector';

/**
 * Finds a platform integration by installation ID
 */
export async function findIntegrationByInstallationId(
  platform: string,
  installationId: string | undefined
) {
  if (!installationId) return null;

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, platform),
        eq(platform_integrations.platform_installation_id, installationId)
      )
    )
    .limit(1);

  return integration || null;
}

/**
 * Gets platform integration for an organization
 */
export async function getIntegrationForOrganization(organizationId: string, platform: string) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, platform)
      )
    )
    .limit(1);

  return integration || null;
}

export async function getAllIntegationsForOrganization(organizationId: string) {
  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(and(eq(platform_integrations.owned_by_organization_id, organizationId)));

  return integrations;
}

export async function getIntegrationById(integrationId: string, organizationId?: string) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      organizationId
        ? and(
            eq(platform_integrations.id, integrationId),
            eq(platform_integrations.owned_by_organization_id, organizationId)
          )
        : eq(platform_integrations.id, integrationId)
    )
    .limit(1);

  return integration || null;
}

/**
 * Creates or updates a platform integration using atomic upsert
 * @param data - Integration data with required platformInstallationId
 */
export async function upsertPlatformIntegration(data: {
  organizationId: string;
  platform: string;
  integrationType: string;
  platformInstallationId: string;
  platformAccountId?: string;
  platformAccountLogin?: string;
  permissions?: IntegrationPermissions | null;
  scopes?: string[];
  repositoryAccess: string;
  repositories?: PlatformRepository[] | null;
  installedAt?: string;
}) {
  await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: data.organizationId,
      platform: data.platform,
      integration_type: data.integrationType,
      platform_installation_id: data.platformInstallationId,
      platform_account_id: data.platformAccountId || null,
      platform_account_login: data.platformAccountLogin || null,
      permissions: (data.permissions as IntegrationPermissions) ?? null,
      scopes: data.scopes || null,
      repository_access: data.repositoryAccess,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      repositories: data.repositories || null,
      installed_at: data.installedAt || new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [
        platform_integrations.owned_by_organization_id,
        platform_integrations.platform,
        platform_integrations.platform_installation_id,
      ],
      set: {
        platform_account_id: sql`EXCLUDED.platform_account_id`,
        platform_account_login: sql`EXCLUDED.platform_account_login`,
        permissions: sql`EXCLUDED.permissions`,
        scopes: sql`EXCLUDED.scopes`,
        repository_access: sql`EXCLUDED.repository_access`,
        integration_status: sql`EXCLUDED.integration_status`,
        repositories: sql`EXCLUDED.repositories`,
        updated_at: sql`now()`,
      },
    });
}

/**
 * Updates repository list for an integration by installation ID
 */
export async function updateIntegrationRepositories(
  platform: string,
  installationId: string,
  repositories: PlatformRepository[]
) {
  await db
    .update(platform_integrations)
    .set({
      repositories,
      repositories_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(platform_integrations.platform, platform),
        eq(platform_integrations.platform_installation_id, installationId)
      )
    );
}

/**
 * Updates repository list for an integration by integration ID
 */
export async function updateRepositoriesForIntegration(
  integrationId: string,
  repositories: PlatformRepository[]
) {
  await db
    .update(platform_integrations)
    .set({
      repositories,
      repositories_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integrationId));
}

/**
 * Suspends a platform integration
 */
export async function suspendIntegration(
  organizationId: string,
  platform: string,
  suspendedBy: string
) {
  await db
    .update(platform_integrations)
    .set({
      integration_status: INTEGRATION_STATUS.SUSPENDED,
      suspended_at: new Date().toISOString(),
      suspended_by: suspendedBy,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, platform)
      )
    );
}

/**
 * Unsuspends a platform integration
 */
export async function unsuspendIntegration(organizationId: string, platform: string) {
  await db
    .update(platform_integrations)
    .set({
      integration_status: INTEGRATION_STATUS.ACTIVE,
      suspended_at: null,
      suspended_by: null,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, platform)
      )
    );
}

/**
 * Deletes a platform integration
 */
export async function deleteIntegration(organizationId: string, platform: string) {
  await db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, platform)
      )
    );
}

/**
 * Gets all platform integrations for an organization (supports multiple)
 */
export async function getIntegrationsByOrganization(organizationId: string, platform: string) {
  return await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, platform)
      )
    )
    .orderBy(desc(platform_integrations.created_at));
}

/**
 * Create a pending GitHub installation (awaiting admin approval)
 * Stores requester info for webhook matching
 * Supports both user and organization ownership
 */
export async function createPendingIntegration({
  organizationId,
  userId,
  requester,
  githubRequester,
  githubAppType,
}: {
  organizationId?: string;
  userId?: string;
  requester: KiloRequester;
  githubRequester?: GitHubRequester;
  githubAppType?: 'standard' | 'lite';
}) {
  // Ensure exactly one of organizationId or userId is provided
  if (!organizationId && !userId) {
    throw new Error('Either organizationId or userId must be provided');
  }
  if (organizationId && userId) {
    throw new Error('Cannot provide both organizationId and userId');
  }

  const metadata = {
    pending_approval: {
      requester,
      github_requester: githubRequester,
      status: PENDING_APPROVAL_STATUS.AWAITING_INSTALLATION,
    },
  };

  const [result] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId || null,
      owned_by_user_id: userId || null,
      platform: PLATFORM.GITHUB,
      integration_type: 'app',
      platform_installation_id: null,
      repository_access: null, // Will be set to GitHub's value when approved
      integration_status: INTEGRATION_STATUS.PENDING, // Use integration_status instead of repository_access
      github_app_type: githubAppType ?? 'standard',
      metadata,
      // Denormalized requester columns for fast indexed queries
      kilo_requester_user_id: requester.kilo_user_id,
      platform_requester_account_id: githubRequester?.id || null,
      installed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .returning();

  return result;
}

/**
 * Find all pending installations (awaiting webhook)
 * Returns all pending installations - we'll determine which one matches based on other criteria
 */
export async function findPendingInstallations() {
  const results = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
        isNull(platform_integrations.platform_installation_id)
      )
    );

  // Filter to only return those with proper pending_approval metadata using Zod for safe parsing
  // Only return 'awaiting_installation' status (simplified flow - no more ambiguous)
  return results.filter(integration => {
    const parseResult = PendingInstallationMetadataWrapperSchema.safeParse(integration.metadata);
    return (
      parseResult.success &&
      parseResult.data.pending_approval.status === PENDING_APPROVAL_STATUS.AWAITING_INSTALLATION
    );
  });
}

/**
 * Find a pending installation by GitHub requester ID
 */
export async function findPendingInstallationByRequesterId(githubRequesterId: string) {
  const [result] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.platform_requester_account_id, githubRequesterId),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
        isNull(platform_integrations.platform_installation_id)
      )
    )
    .limit(1);

  return result || null;
}

/**
 * Find a pending installation by Kilo user ID
 */
export async function findPendingInstallationByKiloUserId(kiloUserId: string) {
  const [result] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.kilo_requester_user_id, kiloUserId),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
        isNull(platform_integrations.platform_installation_id)
      )
    )
    .limit(1);

  return result || null;
}

/**
 * Auto-complete a pending installation
 */
export async function autoCompleteInstallation({
  integrationId,
  installationData,
  existingMetadata,
}: {
  integrationId: string;
  installationData: {
    installation_id: string;
    account_id: string;
    account_login: string;
    repository_selection: string;
    permissions: Record<string, unknown>;
    events: string[];
    created_at: string;
  };
  existingMetadata: Record<string, unknown>;
}) {
  // Keep requester info for historical purposes, but clear pending_approval since it's complete
  // Use Zod to safely parse the existing metadata
  const parseResult = PendingInstallationMetadataWrapperSchema.safeParse(existingMetadata);
  const pendingApproval = parseResult.success ? parseResult.data.pending_approval : undefined;

  const completedMetadata = {
    completed_installation: {
      requester: pendingApproval?.requester,
      github_requester: pendingApproval?.github_requester,
      completed_at: new Date().toISOString(),
    },
  };

  await db
    .update(platform_integrations)
    .set({
      platform_installation_id: installationData.installation_id,
      platform_account_id: installationData.account_id,
      platform_account_login: installationData.account_login,
      repository_access: installationData.repository_selection,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      permissions: installationData.permissions as IntegrationPermissions,
      scopes: installationData.events,
      installed_at: new Date(installationData.created_at).toISOString(),
      metadata: completedMetadata,
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integrationId));
}

/**
 * Owner-aware functions for dual user/organization support
 */

/**
 * Gets platform integration for an owner (user or organization).
 * Optionally filters by integration status (e.g. 'active').
 */
export async function getIntegrationForOwner(
  owner: Owner,
  platform: string,
  status?: IntegrationStatus
) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const conditions = [ownershipCondition, eq(platform_integrations.platform, platform)];
  if (status) {
    conditions.push(eq(platform_integrations.integration_status, status));
  }

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(...conditions))
    .limit(1);

  return integration || null;
}

/**
 * Gets all platform integrations for an owner (user or organization)
 */
export async function getAllIntegrationsForOwner(owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const integrations = await db.select().from(platform_integrations).where(ownershipCondition);

  return integrations;
}

/**
 * Deletes a platform integration for an owner (user or organization)
 */
export async function deleteIntegrationForOwner(owner: Owner, platform: string) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  await db
    .delete(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, platform)));
}

/**
 * Suspends a platform integration for an owner (user or organization)
 */
export async function suspendIntegrationForOwner(
  owner: Owner,
  platform: string,
  suspendedBy: string
) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  await db
    .update(platform_integrations)
    .set({
      integration_status: INTEGRATION_STATUS.SUSPENDED,
      suspended_at: new Date().toISOString(),
      suspended_by: suspendedBy,
      updated_at: new Date().toISOString(),
    })
    .where(and(ownershipCondition, eq(platform_integrations.platform, platform)));
}

/**
 * Unsuspends a platform integration for an owner (user or organization)
 */
export async function unsuspendIntegrationForOwner(owner: Owner, platform: string) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  await db
    .update(platform_integrations)
    .set({
      integration_status: INTEGRATION_STATUS.ACTIVE,
      suspended_at: null,
      suspended_by: null,
      updated_at: new Date().toISOString(),
    })
    .where(and(ownershipCondition, eq(platform_integrations.platform, platform)));
}

/**
 * Owner-aware upsert for platform integrations
 * Supports both user and organization ownership
 * Uses atomic INSERT ... ON CONFLICT DO UPDATE to prevent race conditions
 */
export async function upsertPlatformIntegrationForOwner(
  owner: Owner,
  data: {
    platform: string;
    integrationType: string;
    platformInstallationId: string;
    platformAccountId?: string;
    platformAccountLogin?: string;
    permissions?: IntegrationPermissions | null;
    scopes?: string[];
    repositoryAccess: string;
    repositories?: PlatformRepository[] | null;
    installedAt?: string;
    githubAppType?: GitHubAppType;
  }
) {
  // Build ownership condition based on owner type
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  // Check if integration exists
  const [existing] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.platform, data.platform),
        eq(platform_integrations.platform_installation_id, data.platformInstallationId)
      )
    )
    .limit(1);

  if (existing) {
    // Update existing integration
    await db
      .update(platform_integrations)
      .set({
        platform_account_id: data.platformAccountId || null,
        platform_account_login: data.platformAccountLogin || null,
        permissions: (data.permissions as IntegrationPermissions) ?? null,
        scopes: data.scopes || null,
        repository_access: data.repositoryAccess,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        repositories: data.repositories || null,
        github_app_type: data.githubAppType || existing.github_app_type,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, existing.id));
  } else {
    // Insert new integration
    await db.insert(platform_integrations).values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      platform: data.platform,
      integration_type: data.integrationType,
      platform_installation_id: data.platformInstallationId,
      platform_account_id: data.platformAccountId || null,
      platform_account_login: data.platformAccountLogin || null,
      permissions: (data.permissions as IntegrationPermissions) ?? null,
      scopes: data.scopes || null,
      repository_access: data.repositoryAccess,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      repositories: data.repositories || null,
      installed_at: data.installedAt || new Date().toISOString(),
      github_app_type: data.githubAppType || 'standard',
    });
  }
}
