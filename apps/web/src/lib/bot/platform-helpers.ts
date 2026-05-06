import { type PlatformIdentity } from '@/lib/bot-identity';
import { db } from '@/lib/drizzle';
import { eq, and, sql } from 'drizzle-orm';
import { platform_integrations, type PlatformIntegration } from '@kilocode/db';
import { isOrganizationMember } from '@/lib/organizations/organizations';

/**
 * Look up the platform integration row for a given identity.
 * Platform-agnostic: queries by identity.platform + identity.teamId.
 */
export async function getPlatformIntegration(identity: PlatformIdentity) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, identity.platform),
        eq(platform_integrations.platform_installation_id, identity.teamId)
      )
    )
    .limit(1);

  return integration ?? null;
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
    throw new Error(`Could not find platform integration ${platformIntegrationId}`);
  }

  return integration;
}

export async function getPlatformIntegrationByBotUserId(
  platform: string,
  botUserId: string | undefined
) {
  if (!botUserId) return null;

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, platform),
        eq(sql<string>`${platform_integrations.metadata}->>'bot_user_id'`, botUserId)
      )
    )
    .limit(1);

  return integration ?? null;
}
