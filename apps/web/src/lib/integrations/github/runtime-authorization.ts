import 'server-only';

import { db } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  github_app_installations,
  kilocode_users,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, isNull, notExists, or } from 'drizzle-orm';

export type GitHubRuntimeAuthorizationRejectionReason =
  | 'missing_association'
  | 'ambiguous_association'
  | 'malformed_owner'
  | 'missing_personal_owner'
  | 'blocked_personal_owner'
  | 'deleted_organization'
  | 'integration_status'
  | 'suspended'
  | 'auth_invalid'
  | 'disconnected'
  | 'installation_unavailable'
  | 'sharing_not_allowed';

type GitHubRuntimeAuthorizationDiagnostics = {
  installationId: string;
  appType: GitHubAppType;
  integrationIds: string[];
};

export class GitHubRuntimeAuthorizationError extends Error {
  constructor(
    readonly reason?: GitHubRuntimeAuthorizationRejectionReason,
    readonly diagnostics?: GitHubRuntimeAuthorizationDiagnostics
  ) {
    super('GitHub installation is unavailable for runtime use');
    this.name = 'GitHubRuntimeAuthorizationError';
  }
}

function effectiveAppTypeCondition(appType: GitHubAppType) {
  return appType === 'standard'
    ? or(
        eq(platform_integrations.github_app_type, 'standard'),
        isNull(platform_integrations.github_app_type)
      )
    : eq(platform_integrations.github_app_type, 'lite');
}

type RuntimeAssociation = {
  integration: {
    owned_by_user_id: string | null;
    owned_by_organization_id: string | null;
    integration_status: string | null;
    suspended_at: string | null;
    auth_invalid_at: string | null;
    github_disconnected_at: string | null;
    github_installation_id: string | null;
  };
  installation: {
    lifecycle_state: 'unknown' | 'active' | 'suspended' | 'deleted';
    sharing_mode: 'exclusive' | 'web_cloud_agent';
    suspended_at: string | null;
    deleted_at: string | null;
    auth_invalid_at: string | null;
  } | null;
  organizationDeletedAt: string | null;
  userRecordId: string | null;
  userBlockedReason: string | null;
};

export function getGitHubRuntimeAssociationRejectionReason(
  association: RuntimeAssociation | null | undefined,
  options?: {
    /**
     * Allow a shared (`web_cloud_agent`) canonical installation. Only valid when the caller
     * resolved one exact tenant association; the generic, installation-wide path must stay
     * exclusive-only.
     */
    allowShared?: boolean;
  }
): GitHubRuntimeAuthorizationRejectionReason | null {
  if (!association) return 'missing_association';

  const { integration, installation, organizationDeletedAt, userRecordId, userBlockedReason } =
    association;
  const hasUserOwner = integration.owned_by_user_id !== null;
  const hasOrganizationOwner = integration.owned_by_organization_id !== null;
  if (hasUserOwner === hasOrganizationOwner) return 'malformed_owner';
  if (hasUserOwner) {
    if (userRecordId !== integration.owned_by_user_id) return 'missing_personal_owner';
    if (userBlockedReason !== null) return 'blocked_personal_owner';
  } else if (organizationDeletedAt !== null) {
    return 'deleted_organization';
  }

  // Preserve the legacy health contract; canonical installation data remains shadow state.
  if (integration.integration_status !== INTEGRATION_STATUS.ACTIVE) return 'integration_status';
  if (integration.suspended_at !== null) return 'suspended';
  if (integration.auth_invalid_at !== null) return 'auth_invalid';
  if (integration.github_disconnected_at != null) return 'disconnected';

  // An association bound to a canonical installation must have that installation active, not
  // suspended/deleted/auth-invalid, and exclusively owned UNLESS the caller resolved one exact
  // tenant association and explicitly opted into the shared (web_cloud_agent) carve-out. An
  // association with no canonical binding yet (github_installation_id is null) has nothing
  // further to check here.
  if (integration.github_installation_id !== null) {
    if (
      installation === null ||
      installation.lifecycle_state !== 'active' ||
      installation.suspended_at !== null ||
      installation.deleted_at !== null ||
      installation.auth_invalid_at !== null
    ) {
      return 'installation_unavailable';
    }
    if (
      installation.sharing_mode !== 'exclusive' &&
      !(options?.allowShared === true && installation.sharing_mode === 'web_cloud_agent')
    ) {
      return 'sharing_not_allowed';
    }
  }

  return null;
}

export function isGitHubRuntimeAssociationAuthorized(
  association: RuntimeAssociation | null | undefined,
  options?: { allowShared?: boolean }
): boolean {
  return getGitHubRuntimeAssociationRejectionReason(association, options) === null;
}

export async function assertGitHubInstallationRuntimeAuthorized(
  installationId: string,
  appType: GitHubAppType,
  expectedIntegrationId?: string
): Promise<void> {
  // A non-empty expectedIntegrationId means the caller already resolved the tenant association
  // it is about to act as. That association still has to pass ownership (org membership / user
  // ownership) and local + canonical health below; only the sharing-mode requirement relaxes so
  // a legitimately attached shared association can read its own inventory. Without one (the
  // generic, installation-wide path) shared installations stay rejected.
  //
  // This single normalized value drives the id predicate, the row limit, and the sharing-mode
  // carve-out so they can never diverge: an empty-string id is the generic path, not an exact
  // association.
  const exactAssociationId =
    expectedIntegrationId && expectedIntegrationId.length > 0 ? expectedIntegrationId : undefined;
  const allowShared = exactAssociationId !== undefined;
  const associations = await db
    .select({
      integration: platform_integrations,
      installation: github_app_installations,
      organizationDeletedAt: organizations.deleted_at,
      userRecordId: kilocode_users.id,
      userBlockedReason: kilocode_users.blocked_reason,
    })
    .from(platform_integrations)
    .leftJoin(
      github_app_installations,
      eq(platform_integrations.github_installation_id, github_app_installations.id)
    )
    .leftJoin(organizations, eq(platform_integrations.owned_by_organization_id, organizations.id))
    .leftJoin(kilocode_users, eq(platform_integrations.owned_by_user_id, kilocode_users.id))
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE),
        isNull(platform_integrations.github_disconnected_at),
        isNull(platform_integrations.suspended_at),
        isNull(platform_integrations.auth_invalid_at),
        exactAssociationId !== undefined
          ? eq(platform_integrations.id, exactAssociationId)
          : undefined,
        eq(platform_integrations.platform_installation_id, installationId),
        effectiveAppTypeCondition(appType),
        // Candidacy for THIS query: an unhealthy row must not count toward ambiguous-association
        // detection or be returned as a false candidate alongside a legitimate one (for example,
        // a disconnected former owner's stale row must not make a still-healthy owner's row look
        // ambiguous). getGitHubRuntimeAssociationRejectionReason below still re-checks the same
        // association-level health fields so it stays correct for callers that fetch an
        // association through a different, unfiltered path (for example prepare-review-payload).
        or(
          and(
            isNull(platform_integrations.github_installation_id),
            // An unbound association must not be shadowing an already-canonicalized
            // installation for this same raw installationId+appType; if one exists, this row
            // is stale and must not be treated as a valid candidate.
            notExists(
              db
                .select({ id: github_app_installations.id })
                .from(github_app_installations)
                .where(
                  and(
                    eq(github_app_installations.github_app_type, appType),
                    eq(github_app_installations.installation_id, installationId)
                  )
                )
            )
          ),
          and(
            eq(github_app_installations.github_app_type, appType),
            eq(github_app_installations.installation_id, installationId),
            eq(github_app_installations.lifecycle_state, 'active'),
            allowShared
              ? or(
                  eq(github_app_installations.sharing_mode, 'exclusive'),
                  eq(github_app_installations.sharing_mode, 'web_cloud_agent')
                )
              : eq(github_app_installations.sharing_mode, 'exclusive'),
            isNull(github_app_installations.suspended_at),
            isNull(github_app_installations.deleted_at),
            isNull(github_app_installations.auth_invalid_at)
          )
        )
      )
    )
    .limit(exactAssociationId !== undefined ? 1 : 2);

  const reason =
    associations.length > 1
      ? 'ambiguous_association'
      : getGitHubRuntimeAssociationRejectionReason(associations[0], { allowShared });
  if (reason) {
    throw new GitHubRuntimeAuthorizationError(reason, {
      installationId,
      appType,
      integrationIds: associations.map(({ integration }) => integration.id),
    });
  }
}
