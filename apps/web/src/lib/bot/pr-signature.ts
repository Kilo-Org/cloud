import { getAccessTokenFromInstallation } from '@/lib/integrations/slack-service';
import { getSlackMessagePermalink } from '@/lib/slack-bot/slack-utils';
import { WebClient } from '@slack/web-api';
import type { SlackEvent } from '@chat-adapter/slack';
import type { PlatformIntegration } from '@kilocode/db';
import type { Thread, Message } from 'chat';

type RequesterInfo = {
  displayName: string;
  messageLink?: string;
  platform: string;
};

const PLATFORM_LINKS: Record<string, { label: string; url: string }> = {
  slack: { label: 'Kilo for Slack', url: 'https://kilo.ai/features/slack-integration' },
  discord: { label: 'Kilo for Discord', url: 'https://kilo.ai' },
};

const DEFAULT_PLATFORM_LINK = { label: 'Kilo', url: 'https://kilo.ai' };

/**
 * Build the PR signature instruction to append to the Cloud Agent prompt.
 * Instructs the agent to include a "Built for …" line at the end of any
 * PR/MR description it creates.
 */
export function buildPrSignature(requesterInfo: RequesterInfo): string {
  const requesterPart = requesterInfo.messageLink
    ? `[${requesterInfo.displayName}](${requesterInfo.messageLink})`
    : requesterInfo.displayName;

  const { label, url } = PLATFORM_LINKS[requesterInfo.platform] ?? DEFAULT_PLATFORM_LINK;

  return `

---
**PR Signature to include in the PR description:**
If you create a pull request or merge request, include the following signature at the end of the PR/MR description:

Built for ${requesterPart} by [${label}](${url})`;
}

/**
 * Gather requester info (display name + message link) for the PR signature.
 * Platform-specific: uses the Slack API for permalinks, constructs Discord
 * links from IDs, and degrades gracefully for unknown platforms.
 */
export async function getRequesterInfo(
  thread: Thread,
  message: Message,
  platformIntegration: PlatformIntegration
): Promise<RequesterInfo | undefined> {
  const platform = thread.id.split(':')[0];
  const displayName = message.author.fullName || message.author.userName || message.author.userId;

  switch (platform) {
    case 'slack':
      return getSlackRequesterInfo(message, platformIntegration, displayName);
    case 'discord':
      return getDiscordRequesterInfo(message, displayName);
    default:
      return { displayName, platform };
  }
}

async function getSlackRequesterInfo(
  message: Message,
  platformIntegration: PlatformIntegration,
  displayName: string
): Promise<RequesterInfo> {
  const accessToken = getAccessTokenFromInstallation(platformIntegration);
  if (!accessToken) {
    return { displayName, platform: 'slack' };
  }

  const raw = (message as Message<SlackEvent>).raw;
  const channelId =
    typeof raw === 'object' && raw !== null && 'channel' in raw
      ? (raw as { channel?: string }).channel
      : undefined;
  const messageTs = message.id; // chat SDK uses Slack ts as the message ID

  if (!channelId || !messageTs) {
    return { displayName, platform: 'slack' };
  }

  const slackClient = new WebClient(accessToken);
  const permalink = await getSlackMessagePermalink(slackClient, channelId, messageTs);

  return { displayName, messageLink: permalink, platform: 'slack' };
}

function getDiscordRequesterInfo(message: Message, displayName: string): RequesterInfo {
  const raw = message.raw as { guild_id?: string; channel_id?: string } | null;
  const guildId = raw?.guild_id;
  const channelId = raw?.channel_id;
  const messageId = message.id;

  const messageLink =
    guildId && channelId && messageId
      ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
      : undefined;

  return { displayName, messageLink, platform: 'discord' };
}
