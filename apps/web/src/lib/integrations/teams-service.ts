import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { APP_URL } from '@/lib/constants';
import {
  TEAMS_APP_ID,
  TEAMS_APP_INSTALL_URL,
  TEAMS_APP_PASSWORD,
  TEAMS_APP_TENANT_ID,
  TEAMS_APP_TYPE,
} from '@/lib/config.server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import {
  createAllowPredicateFromRestrictions,
  hasActiveModelRestrictions,
} from '@/lib/model-allow.server';
import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';

const TEAMS_DEFAULT_MODEL = KILO_AUTO_FREE_MODEL.id;

type TeamsMetadata = Record<string, unknown> & {
  bot_enabled?: boolean;
  model_slug?: string;
  tenant_name?: string | null;
};

type TeamsUninstallOptions = {
  deleteChatSdkIdentityCache?: (tenantId: string) => Promise<void>;
};

export class TeamsTenantAlreadyConnectedError extends Error {
  constructor(tenantName: string) {
    super(
      `${tenantName} is already connected to another Kilo account or organization. Disconnect it there before connecting it here.`
    );
    this.name = 'TeamsTenantAlreadyConnectedError';
  }
}

function isTeamsAppConfigured(): boolean {
  if (!TEAMS_APP_ID || !TEAMS_APP_PASSWORD) return false;
  if (TEAMS_APP_TYPE === 'SingleTenant' && !TEAMS_APP_TENANT_ID) return false;
  return true;
}

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

function isOwnedBy(integration: PlatformIntegration, owner: Owner): boolean {
  return owner.type === 'user'
    ? integration.owned_by_user_id === owner.id && integration.owned_by_organization_id === null
    : integration.owned_by_organization_id === owner.id && integration.owned_by_user_id === null;
}

function readTeamsMetadata(integration: PlatformIntegration | null): TeamsMetadata {
  return integration?.metadata && typeof integration.metadata === 'object'
    ? (integration.metadata as TeamsMetadata)
    : {};
}

function isTeamsTenantUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  if (
    'constraint' in error &&
    error.constraint === 'UQ_platform_integrations_teams_platform_inst'
  ) {
    return true;
  }

  return (
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('UQ_platform_integrations_teams_platform_inst')
  );
}

export function getTeamsSetupInfo() {
  return {
    configured: isTeamsAppConfigured(),
    installUrl: TEAMS_APP_INSTALL_URL || null,
    webhookUrl: `${APP_URL}/api/chat/webhooks/teams`,
  };
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

async function getConflictingTeamsInstallation(
  owner: Owner,
  tenantId: string
): Promise<PlatformIntegration | null> {
  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.TEAMS),
        eq(platform_integrations.platform_installation_id, tenantId)
      )
    )
    .limit(2);

  return integrations.find(integration => !isOwnedBy(integration, owner)) ?? null;
}

export async function upsertTeamsInstallation({
  owner,
  tenantId,
  tenantName,
}: {
  owner: Owner;
  tenantId: string;
  tenantName?: string | null;
}): Promise<PlatformIntegration> {
  const existing = await getInstallation(owner);
  const accountName = tenantName?.trim() || 'Microsoft Teams tenant';

  const conflicting = await getConflictingTeamsInstallation(owner, tenantId);
  if (conflicting) {
    throw new TeamsTenantAlreadyConnectedError(accountName);
  }

  const defaultModel =
    owner.type === 'org'
      ? await getDefaultAllowedModel(owner.id, TEAMS_DEFAULT_MODEL)
      : TEAMS_DEFAULT_MODEL;

  const existingMetadata = readTeamsMetadata(existing);
  const metadata: TeamsMetadata = {
    ...existingMetadata,
    bot_enabled: true,
    model_slug:
      typeof existingMetadata.model_slug === 'string' ? existingMetadata.model_slug : defaultModel,
    tenant_name: tenantName ?? existingMetadata.tenant_name ?? null,
  };

  if (existing) {
    try {
      const [updated] = await db
        .update(platform_integrations)
        .set({
          platform_installation_id: tenantId,
          platform_account_id: tenantId,
          platform_account_login: accountName,
          scopes: [],
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata,
          updated_at: new Date().toISOString(),
        })
        .where(eq(platform_integrations.id, existing.id))
        .returning();

      return updated;
    } catch (error) {
      if (isTeamsTenantUniqueViolation(error)) {
        throw new TeamsTenantAlreadyConnectedError(accountName);
      }
      throw error;
    }
  }

  try {
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
        scopes: [],
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata,
        installed_at: new Date().toISOString(),
      })
      .returning();

    return created;
  } catch (error) {
    if (isTeamsTenantUniqueViolation(error)) {
      throw new TeamsTenantAlreadyConnectedError(accountName);
    }
    throw error;
  }
}

export async function uninstallApp(owner: Owner, options: TeamsUninstallOptions = {}) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Teams installation not found',
    });
  }

  const tenantId = integration.platform_installation_id ?? integration.platform_account_id;
  if (options.deleteChatSdkIdentityCache) {
    if (!tenantId) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Teams installation is missing a tenant ID',
      });
    }
    await options.deleteChatSdkIdentityCache(tenantId);
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
  return { success: true };
}

export async function removeDbRowOnly(owner: Owner) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Teams installation not found',
    });
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
  return { success: true };
}

export async function updateModel(
  owner: Owner,
  modelSlug: string
): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Teams installation found' };
  }

  if (owner.type === 'org') {
    const organization = await getOrganizationById(owner.id);
    if (organization) {
      const restrictions = getEffectiveModelRestrictions(organization);
      if (hasActiveModelRestrictions(restrictions)) {
        const isAllowed = createAllowPredicateFromRestrictions(restrictions);
        if (!(await isAllowed(modelSlug))) {
          return { success: false, error: 'Model is not allowed by organization policy' };
        }
      }
    }
  }

  await db
    .update(platform_integrations)
    .set({
      metadata: {
        ...readTeamsMetadata(integration),
        model_slug: modelSlug,
      },
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

export async function getModel(owner: Owner): Promise<string | null> {
  const integration = await getInstallation(owner);
  if (!integration) return null;
  const metadata = readTeamsMetadata(integration);
  return metadata.model_slug || null;
}
