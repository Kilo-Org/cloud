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
import { and, eq, isNull, or } from 'drizzle-orm';

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
  | 'disconnected';

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
    suspended_at: string | null;
    deleted_at: string | null;
    auth_invalid_at: string | null;
  } | null;
  organizationDeletedAt: string | null;
  userRecordId: string | null;
  userBlockedReason: string | null;
};

export function getGitHubRuntimeAssociationRejectionReason(
  association: RuntimeAssociation | null | undefined
): GitHubRuntimeAuthorizationRejectionReason | null {
  if (!association) return 'missing_association';

  const { integration, organizationDeletedAt, userRecordId, userBlockedReason } = association;
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
  return null;
}

export function isGitHubRuntimeAssociationAuthorized(
  association: RuntimeAssociation | null | undefined
): boolean {
  return getGitHubRuntimeAssociationRejectionReason(association) === null;
}

const REPORTED_GITHUB_RUNTIME_AUTHORIZATION_REASONS: ReadonlySet<GitHubRuntimeAuthorizationRejectionReason> =
  new Set([
    'ambiguous_association',
    'malformed_owner',
    'missing_personal_owner',
    'blocked_personal_owner',
    'deleted_organization',
    'integration_status',
    'suspended',
    'auth_invalid',
    'disconnected',
  ]);

export function isUnexpectedGitHubRuntimeAuthorizationDenial(
  error: unknown
): error is GitHubRuntimeAuthorizationError {
  return (
    error instanceof GitHubRuntimeAuthorizationError &&
    error.reason !== undefined &&
    REPORTED_GITHUB_RUNTIME_AUTHORIZATION_REASONS.has(error.reason)
  );
}

export async function assertGitHubInstallationRuntimeAuthorized(
  installationId: string,
  appType: GitHubAppType
): Promise<void> {
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
        eq(platform_integrations.platform_installation_id, installationId),
        effectiveAppTypeCondition(appType)
      )
    )
    .limit(2);

  const reason =
    associations.length > 1
      ? 'ambiguous_association'
      : getGitHubRuntimeAssociationRejectionReason(associations[0]);
  if (reason) {
    throw new GitHubRuntimeAuthorizationError(reason, {
      installationId,
      appType,
      integrationIds: associations.map(({ integration }) => integration.id),
    });
  }
}
