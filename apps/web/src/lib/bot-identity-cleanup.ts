import 'server-only';
import { captureException } from '@sentry/nextjs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { platform_integrations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { unlinkKiloUserFromBotIdentities, unlinkTeamKiloUser } from '@/lib/bot-identity';

async function getInitializedBot() {
  const { bot } = await import('@/lib/bot');
  await bot.initialize();
  return bot;
}

export async function unlinkBotIdentitiesForOrganizationMember(
  organizationId: string,
  kiloUserId: string
): Promise<number> {
  const integrations = await db
    .select({
      platform: platform_integrations.platform,
      platformInstallationId: platform_integrations.platform_installation_id,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        isNotNull(platform_integrations.platform_installation_id)
      )
    );

  if (integrations.length === 0) return 0;

  const bot = await getInitializedBot();
  const state = bot.getState();
  let deletedKeys = 0;

  for (const integration of integrations) {
    if (!integration.platformInstallationId) continue;
    deletedKeys += await unlinkTeamKiloUser(
      state,
      integration.platform,
      integration.platformInstallationId,
      kiloUserId
    );
  }

  return deletedKeys;
}

export async function tryUnlinkBotIdentitiesForOrganizationMember(
  organizationId: string,
  kiloUserId: string
): Promise<void> {
  try {
    await unlinkBotIdentitiesForOrganizationMember(organizationId, kiloUserId);
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'organization-member-unlink' },
      extra: { organizationId, kiloUserId },
    });
  }
}

export async function unlinkBotIdentitiesForDeletedUser(kiloUserId: string): Promise<number> {
  const bot = await getInitializedBot();
  return await unlinkKiloUserFromBotIdentities(bot.getState(), kiloUserId);
}

export async function tryUnlinkBotIdentitiesForDeletedUser(kiloUserId: string): Promise<void> {
  try {
    await unlinkBotIdentitiesForDeletedUser(kiloUserId);
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'gdpr-delete-user-unlink' },
      extra: { kiloUserId },
    });
  }
}
