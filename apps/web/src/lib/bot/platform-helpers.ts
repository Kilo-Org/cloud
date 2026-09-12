import { type PlatformIdentity } from '@/lib/bot-identity';
import { db } from '@/lib/drizzle';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import {
  organizations,
  platform_integrations,
  provider_installation_reservations,
  type PlatformIntegration,
} from '@kilocode/db';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { ownerHasSharedGitHubInstallation } from '@/lib/integrations/provider-oauth-attempts';

function isAvailableForBot(integration: PlatformIntegration): boolean {
  return (
    integration.integration_status === 'active' &&
    (integration.platform !== 'github' || isPlatformIntegrationHealthy(integration))
  );
}

async function isSlackIntegrationAvailable(integration: PlatformIntegration): Promise<boolean> {
  if (integration.platform !== 'slack' || integration.integration_status !== 'active') return false;
  const owner = integration.owned_by_organization_id
    ? { type: 'org' as const, id: integration.owned_by_organization_id }
    : integration.owned_by_user_id
      ? { type: 'user' as const, id: integration.owned_by_user_id }
      : null;
  if (!owner || !integration.platform_installation_id) return false;
  if (owner.type === 'org') {
    const [organization] = await db
      .select({ deletedAt: organizations.deleted_at })
      .from(organizations)
      .where(eq(organizations.id, owner.id))
      .limit(1);
    if (!organization || organization.deletedAt) return false;
  }
  if (!(await ownerHasSharedGitHubInstallation(owner))) return true;
  const [reservation] = await db
    .select({ id: provider_installation_reservations.id })
    .from(provider_installation_reservations)
    .where(
      and(
        eq(provider_installation_reservations.provider, 'slack'),
        eq(
          provider_installation_reservations.provider_installation_id,
          integration.platform_installation_id
        ),
        eq(provider_installation_reservations.platform_integration_id, integration.id),
        eq(provider_installation_reservations.status, 'active'),
        owner.type === 'org'
          ? and(
              eq(provider_installation_reservations.owned_by_organization_id, owner.id),
              isNull(provider_installation_reservations.owned_by_user_id)
            )
          : and(
              eq(provider_installation_reservations.owned_by_user_id, owner.id),
              isNull(provider_installation_reservations.owned_by_organization_id)
            )
      )
    )
    .limit(1);
  return Boolean(reservation);
}

export class PlatformIntegrationUnavailableError extends Error {
  constructor(platformIntegrationId: string) {
    super(`Platform integration ${platformIntegrationId} is unavailable`);
    this.name = 'PlatformIntegrationUnavailableError';
  }
}

export class PlatformIntegrationNotFoundError extends Error {
  constructor(platformIntegrationId: string) {
    super(`Could not find platform integration ${platformIntegrationId}`);
    this.name = 'PlatformIntegrationNotFoundError';
  }
}

/**
 * Look up the platform integration row for a given identity.
 * Platform-agnostic: queries by identity.platform + identity.teamId.
 */
export async function getPlatformIntegration(identity: PlatformIdentity) {
  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, identity.platform),
        eq(platform_integrations.platform_installation_id, identity.teamId),
        identity.platform === 'github'
          ? identity.githubAppType === 'lite'
            ? eq(platform_integrations.github_app_type, 'lite')
            : or(
                eq(platform_integrations.github_app_type, 'standard'),
                isNull(platform_integrations.github_app_type)
              )
          : undefined
      )
    )
    .limit(2);

  if (integrations.length !== 1) return null;
  const [integration] = integrations;
  if (!integration || !isAvailableForBot(integration)) return null;
  return integration.platform === 'slack' && !(await isSlackIntegrationAvailable(integration))
    ? null
    : integration;
}

export async function canKiloUserAccessPlatformIntegration(
  integration: PlatformIntegration,
  kiloUserId: string
): Promise<boolean> {
  if (integration.owned_by_organization_id) {
    return await isOrganizationMember(integration.owned_by_organization_id, kiloUserId);
  }

  if (integration.owned_by_user_id) {
    return integration.owned_by_user_id === kiloUserId;
  }

  return false;
}

export async function getPlatformIntegrationById(platformIntegrationId: string) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(eq(platform_integrations.id, platformIntegrationId))
    .limit(1);
  if (!integration) {
    throw new PlatformIntegrationNotFoundError(platformIntegrationId);
  }

  if (!isAvailableForBot(integration)) {
    throw new PlatformIntegrationUnavailableError(platformIntegrationId);
  }
  if (integration.platform === 'slack' && !(await isSlackIntegrationAvailable(integration))) {
    throw new PlatformIntegrationUnavailableError(platformIntegrationId);
  }

  return integration;
}

export async function getPlatformIntegrationByBotUserId(
  platform: string,
  botUserId: string | undefined
) {
  if (!botUserId) return null;

  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, platform),
        eq(sql<string>`${platform_integrations.metadata}->>'bot_user_id'`, botUserId)
      )
    )
    .limit(2);

  if (integrations.length !== 1) return null;
  const [integration] = integrations;
  if (!integration || !isAvailableForBot(integration)) return null;
  return integration.platform === 'slack' && !(await isSlackIntegrationAvailable(integration))
    ? null
    : integration;
}
