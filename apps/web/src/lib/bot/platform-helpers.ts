import type { PlatformIdentity } from '@/lib/bot-identity';
import { db } from '@/lib/drizzle';
import { eq, and, sql } from 'drizzle-orm';
import { type SlackEvent } from '@chat-adapter/slack';
import { platform_integrations } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { PLATFORM } from '@/lib/integrations/core/constants';

export function getSlackTeamId(message: Message<SlackEvent>): string {
  const teamId = message.raw.team_id ?? message.raw.team;
  if (!teamId) throw new Error('Expected a teamId in message.raw');
  return teamId;
}

/**
 * Extract platform identity coordinates from any adapter's message.
 * Extend the switch for Discord / Teams / Google Chat / etc.
 */
export function getPlatformIdentity(thread: Thread, message: Message): PlatformIdentity {
  const platform = thread.id.split(':')[0]; // "slack", "discord", "gchat", "teams", ...

  switch (platform) {
    case 'slack': {
      const teamId = getSlackTeamId(message as Message<SlackEvent>);
      return { platform: PLATFORM.SLACK, teamId, userId: message.author.userId };
    }
    default:
      throw new Error(`PlatformNotSupported: ${platform}`);
  }
}

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
