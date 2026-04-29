import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/kilo-auto';

const TEAMS_DEFAULT_MODEL = KILO_AUTO_FREE_MODEL.id;

function getOwnershipConditions(owner: Owner) {
  return owner.type === 'user'
    ? [
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id),
      ]
    : [
        eq(platform_integrations.owned_by_organization_id, owner.id),
        isNull(platform_integrations.owned_by_user_id),
      ];
}

export async function getInstallation(owner: Owner): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(...getOwnershipConditions(owner), eq(platform_integrations.platform, PLATFORM.TEAMS))
    )
    .limit(1);

  return integration || null;
}

export async function getInstallationByTenantId(
  tenantId: string
): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.TEAMS),
        eq(platform_integrations.platform_installation_id, tenantId)
      )
    )
    .limit(1);

  return integration || null;
}

export async function upsertTeamsInstallation({
  owner,
  tenantId,
  tenantName,
}: {
  owner: Owner;
  tenantId: string;
  tenantName?: string;
}): Promise<PlatformIntegration> {
  const existing = await getInstallation(owner);
  const accountName = tenantName || tenantId;

  if (existing) {
    const existingMetadata = (existing.metadata || {}) as Record<string, unknown>;
    const metadata = existingMetadata.model_slug
      ? existingMetadata
      : {
          ...existingMetadata,
          model_slug: await getDefaultModel(owner),
        };
    const [updated] = await db
      .update(platform_integrations)
      .set({
        platform_installation_id: tenantId,
        platform_account_id: tenantId,
        platform_account_login: accountName,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, existing.id))
      .returning();

    return updated;
  }

  const [created] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      platform: PLATFORM.TEAMS,
      integration_type: 'app',
      platform_installation_id: tenantId,
      platform_account_id: tenantId,
      platform_account_login: accountName,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata: { model_slug: await getDefaultModel(owner) },
      installed_at: new Date().toISOString(),
    })
    .returning();

  return created;
}

async function getDefaultModel(owner: Owner): Promise<string> {
  return owner.type === 'org'
    ? await getDefaultAllowedModel(owner.id, TEAMS_DEFAULT_MODEL)
    : TEAMS_DEFAULT_MODEL;
}
