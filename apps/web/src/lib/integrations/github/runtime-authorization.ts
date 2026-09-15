import 'server-only';

import { db } from '@/lib/drizzle';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  github_app_installations,
  kilocode_users,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';

export type GitHubRuntimeAuthorizationDenialReason =
  | 'missing_association'
  | 'ambiguous_association'
  | 'invalid_owner'
  | 'unhealthy_integration';

export class GitHubRuntimeAuthorizationError extends Error {
  readonly reason: GitHubRuntimeAuthorizationDenialReason;

  constructor(reason: GitHubRuntimeAuthorizationDenialReason) {
    super('GitHub installation is unavailable for runtime use');
    this.name = 'GitHubRuntimeAuthorizationError';
    this.reason = reason;
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

export function getGitHubRuntimeAssociationDenialReason(
  association: RuntimeAssociation | null | undefined
): GitHubRuntimeAuthorizationDenialReason | null {
  if (!association) return 'missing_association';

  const { integration, organizationDeletedAt, userRecordId, userBlockedReason } = association;
  const hasValidOwner =
    (integration.owned_by_user_id !== null &&
      integration.owned_by_organization_id === null &&
      userRecordId === integration.owned_by_user_id &&
      userBlockedReason === null) ||
    (integration.owned_by_user_id === null &&
      integration.owned_by_organization_id !== null &&
      organizationDeletedAt === null);
  if (!hasValidOwner) return 'invalid_owner';
  if (!isPlatformIntegrationHealthy(integration)) return 'unhealthy_integration';
  return null;
}

export function isGitHubRuntimeAssociationAuthorized(
  association: RuntimeAssociation | null | undefined
): boolean {
  return getGitHubRuntimeAssociationDenialReason(association) === null;
}

export function isUnexpectedGitHubRuntimeAuthorizationDenial(
  error: unknown
): error is GitHubRuntimeAuthorizationError {
  return (
    error instanceof GitHubRuntimeAuthorizationError &&
    (error.reason === 'ambiguous_association' ||
      error.reason === 'invalid_owner' ||
      error.reason === 'unhealthy_integration')
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

  if (associations.length === 0) throw new GitHubRuntimeAuthorizationError('missing_association');
  if (associations.length > 1) throw new GitHubRuntimeAuthorizationError('ambiguous_association');

  const [association] = associations;
  const denialReason = getGitHubRuntimeAssociationDenialReason(association);
  if (denialReason) throw new GitHubRuntimeAuthorizationError(denialReason);
}
