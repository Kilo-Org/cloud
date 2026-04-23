import type { PlatformIdentity } from '@/lib/bot-identity';
import { db } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { type SlackEvent } from '@chat-adapter/slack';
import { platform_integrations } from '@kilocode/db';
import type { Message, Thread } from 'chat';

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
      return { platform: 'slack', teamId, userId: message.author.userId };
    }
    default:
      throw new Error(`PlatformNotSupported: ${platform}`);
  }
}

async function getSlackPlatformIntegration(teamId: string) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId)
      )
    )
    .limit(1);

  return integration ?? null;
}

export async function getPlatformIntegration(thread: Thread, message: Message) {
  const platform = thread.id.split(':')[0];

  switch (platform) {
    case 'slack':
      return await getSlackPlatformIntegration(getSlackTeamId(message as Message<SlackEvent>));
    default:
      throw new Error(`PlatformNotSupported: ${platform}`);
  }
}
