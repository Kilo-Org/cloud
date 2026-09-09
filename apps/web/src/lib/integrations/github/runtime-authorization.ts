import 'server-only';

import { db } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  github_app_installations,
  kilocode_users,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';

export class GitHubRuntimeAuthorizationError extends Error {
  constructor() {
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

export function isGitHubRuntimeAssociationAuthorized(
  association: RuntimeAssociation | null | undefined
): boolean {
  if (!association) return false;

  const { integration, installation, organizationDeletedAt, userRecordId, userBlockedReason } =
    association;
  const hasValidOwner =
    (integration.owned_by_user_id !== null &&
      integration.owned_by_organization_id === null &&
      userRecordId === integration.owned_by_user_id &&
      userBlockedReason === null) ||
    (integration.owned_by_user_id === null &&
      integration.owned_by_organization_id !== null &&
      organizationDeletedAt === null);
  const hasAvailableInstallation =
    integration.github_installation_id === null
      ? installation === null
      : installation?.lifecycle_state === 'active' &&
        installation.sharing_mode === 'exclusive' &&
        installation.suspended_at === null &&
        installation.deleted_at === null &&
        installation.auth_invalid_at === null;
  return (
    hasValidOwner &&
    hasAvailableInstallation &&
    isPlatformIntegrationHealthy(integration) &&
    integration.integration_status === INTEGRATION_STATUS.ACTIVE
  );
}

export async function assertGitHubInstallationRuntimeAuthorized(
  installationId: string,
  appType: GitHubAppType,
  expectedIntegrationId?: string
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
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE),
        isNull(platform_integrations.github_disconnected_at),
        isNull(platform_integrations.suspended_at),
        isNull(platform_integrations.auth_invalid_at),
        expectedIntegrationId ? eq(platform_integrations.id, expectedIntegrationId) : undefined,
        eq(platform_integrations.platform_installation_id, installationId),
        effectiveAppTypeCondition(appType),
        or(
          isNull(platform_integrations.github_installation_id),
          and(
            eq(github_app_installations.github_app_type, appType),
            eq(github_app_installations.installation_id, installationId),
            eq(github_app_installations.lifecycle_state, 'active'),
            eq(github_app_installations.sharing_mode, 'exclusive'),
            isNull(github_app_installations.suspended_at),
            isNull(github_app_installations.deleted_at),
            isNull(github_app_installations.auth_invalid_at)
          )
        )
      )
    )
    .limit(expectedIntegrationId ? 1 : 2);

  if (associations.length !== 1) throw new GitHubRuntimeAuthorizationError();

  const [association] = associations;
  if (!association) throw new GitHubRuntimeAuthorizationError();

  if (!isGitHubRuntimeAssociationAuthorized(association)) {
    throw new GitHubRuntimeAuthorizationError();
  }
}
