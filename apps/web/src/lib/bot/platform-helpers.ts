import type { PlatformIdentity } from '@/lib/bot-identity';
import { db } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { type SlackEvent } from '@chat-adapter/slack';
import { platform_integrations } from '@kilocode/db';
import type { Message, Thread } from 'chat';

type TeamsActivity = {
  channelData?: {
    team?: { aadGroupId?: string; name?: string };
    tenant?: { id?: string; name?: string };
  };
  conversation?: { tenantId?: string };
};

export function getSlackTeamId(message: Message<SlackEvent>): string {
  const teamId = message.raw.team_id ?? message.raw.team;
  if (!teamId) throw new Error('Expected a teamId in message.raw');
  return teamId;
}

function getTeamsTenantId(message: Message<TeamsActivity>): string {
  const tenantId = message.raw.conversation?.tenantId ?? message.raw.channelData?.tenant?.id;
  if (!tenantId) throw new Error('Expected a tenant ID in Teams message.raw');
  return tenantId;
}

function getTeamsTenantName(message: Message<TeamsActivity>): string | undefined {
  return message.raw.channelData?.team?.name ?? message.raw.channelData?.tenant?.name;
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
    case 'teams': {
      const teamsMessage = message as Message<TeamsActivity>;
      const teamName = getTeamsTenantName(teamsMessage);
      return {
        platform: 'teams',
        teamId: getTeamsTenantId(teamsMessage),
        userId: message.author.userId,
        ...(teamName ? { teamName } : {}),
      };
    }
    default:
      throw new Error(`PlatformNotSupported: ${platform}`);
  }
}

async function getPlatformIntegrationByInstallationId(platform: string, installationId: string) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, platform),
        eq(platform_integrations.platform_installation_id, installationId)
      )
    )
    .limit(1);

  return integration ?? null;
}

export async function getPlatformIntegration(thread: Thread, message: Message) {
  const platform = thread.id.split(':')[0];

  switch (platform) {
    case 'slack':
      return await getPlatformIntegrationByInstallationId(
        PLATFORM.SLACK,
        getSlackTeamId(message as Message<SlackEvent>)
      );
    case 'teams':
      return await getPlatformIntegrationByInstallationId(
        PLATFORM.TEAMS,
        getTeamsTenantId(message as Message<TeamsActivity>)
      );
    default:
      throw new Error(`PlatformNotSupported: ${platform}`);
  }
}
