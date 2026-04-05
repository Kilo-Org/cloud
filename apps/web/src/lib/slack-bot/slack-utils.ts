import { WebClient, type SlackEvent } from '@slack/web-api';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type SlackUserDisplayAndRealName = {
  displayName: string;
  realName?: string;
};

export async function getSlackUserDisplayAndRealName(
  client: WebClient,
  userId: string
): Promise<SlackUserDisplayAndRealName | undefined> {
  try {
    const result = await client.users.info({ user: userId });

    if (!result.ok || !result.user) {
      return undefined;
    }

    const user = result.user;
    const profile = user.profile;

    const displayName =
      profile?.display_name || profile?.display_name_normalized || user.name || userId;

    const realName = profile?.real_name || profile?.real_name_normalized || undefined;

    return { displayName, realName };
  } catch {
    return undefined;
  }
}

/**
 * Get a Slack user's email address.
 * Requires the `users:read.email` scope on the Slack app.
 *
 * @param client - The Slack WebClient initialized with the workspace access token
 * @param userId - The Slack user ID (e.g., "U1234567890")
 * @returns The user's email address, or undefined if not available
 */
export async function getSlackUserEmail(
  client: WebClient,
  userId: string
): Promise<string | undefined> {
  try {
    const result = await client.users.info({ user: userId });

    if (!result.ok || !result.user) {
      return undefined;
    }

    return result.user.profile?.email;
  } catch {
    return undefined;
  }
}

/**
 * Get a Slack user's email using an installation's access token.
 * Requires the `users:read.email` scope on the Slack app.
 *
 * @param installation - The Slack installation with metadata containing access_token
 * @param userId - The Slack user ID (e.g., "U1234567890")
 * @returns The user's email address, or undefined if not available
 */
export async function getSlackUserEmailFromInstallation(
  installation: { metadata: unknown } | null,
  userId: string
): Promise<string | undefined> {
  const metadata = installation?.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }

  const accessToken = metadata['access_token'];
  if (typeof accessToken !== 'string') {
    return undefined;
  }

  const client = new WebClient(accessToken);
  return getSlackUserEmail(client, userId);
}

export function formatSlackUserDisplayAndRealName(
  displayName: string,
  realName: string | undefined
): string {
  const safeDisplayName = displayName.trim();
  const safeRealName = realName?.trim();

  if (!safeRealName || safeRealName === safeDisplayName) {
    return `@${safeDisplayName}`;
  }

  return `@${safeDisplayName} (${safeRealName})`;
}

export async function replaceSlackUserMentionsWithNames(
  client: WebClient,
  text: string
): Promise<string> {
  // Matches <@U123ABC456> and <@U123ABC456|username>
  const mentionRegex = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
  const userIds = new Set<string>();

  for (const match of text.matchAll(mentionRegex)) {
    const userId = match[1];
    if (userId) userIds.add(userId);
  }

  if (userIds.size === 0) {
    return text;
  }

  const replacements = new Map<string, string>();

  // Parallelize user lookups instead of sequential
  const userLookups = await Promise.all(
    Array.from(userIds).map(async userId => ({
      userId,
      user: await getSlackUserDisplayAndRealName(client, userId),
    }))
  );

  for (const { userId, user } of userLookups) {
    if (!user) continue;
    replacements.set(userId, formatSlackUserDisplayAndRealName(user.displayName, user.realName));
  }

  if (replacements.size === 0) {
    return text;
  }

  let out = text;
  for (const [userId, replacement] of replacements) {
    const pattern = new RegExp(`<@${escapeRegExp(userId)}(\\|[^>]+)?>`, 'g');
    out = out.replace(pattern, replacement);
  }

  return out;
}

export function stripSlackBotMention(
  text: string | undefined,
  botUserId: string | undefined
): string {
  if (!text) return '';
  // Preferred path: remove only this app/bot's user mention (and keep other mentions intact)
  if (botUserId) {
    const pattern = new RegExp(`<@${escapeRegExp(botUserId)}(\\|[^>]+)?>`, 'g');
    return text.replace(pattern, '').trim();
  }

  // Fallback: remove only the first/leading mention (Slack app_mention text typically starts with the bot mention)
  // This still preserves any other user mentions in the rest of the message for context.
  return text.replace(/^<@[A-Z0-9]+(?:\|[^>]+)?>\s*/u, '').trim();
}

/**
 * Get a permalink URL for a Slack message.
 * The permalink can be used to link directly to the message in Slack.
 *
 * @param client - The Slack WebClient initialized with the workspace access token
 * @param channelId - The Slack channel ID
 * @param messageTs - The message timestamp
 * @returns The permalink URL, or undefined if not available
 */
export async function getSlackMessagePermalink(
  client: WebClient,
  channelId: string,
  messageTs: string
): Promise<string | undefined> {
  try {
    const result = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    });

    if (!result.ok || !result.permalink) {
      return undefined;
    }

    return result.permalink;
  } catch {
    return undefined;
  }
}

export function getSlackBotUserIdFromInstallation(
  installation: { metadata: unknown } | null
): string | undefined {
  const metadata = installation?.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }

  const botUserId = metadata['bot_user_id'];
  return typeof botUserId === 'string' ? botUserId : undefined;
}

export function isExternalWorkspaceEvent(event: SlackEvent) {
  return 'user_team' in event && event.user_team && event.team !== event.user_team;
}
