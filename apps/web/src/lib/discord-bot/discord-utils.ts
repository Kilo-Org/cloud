import 'server-only';
import { DISCORD_BOT_TOKEN } from '@/lib/config.server';
import { buildDiscordApiUrl, isDiscordSnowflake, parseDiscordSnowflake } from './discord-id';

/**
 * Strip the bot's own mention from a Discord message.
 * Discord mentions look like <@BOT_ID> or <@!BOT_ID> (nickname mention).
 */
export function stripDiscordBotMention(text: string, botUserId: string | null): string {
  if (!botUserId || !isDiscordSnowflake(botUserId)) return text;
  // Match both <@ID> and <@!ID> (nickname mention format)
  return text.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
}

/**
 * Replace Discord user mentions (<@USER_ID>) with display names.
 * Fetches user info from Discord API for each unique mention.
 */
export async function replaceDiscordUserMentionsWithNames(
  text: string,
  guildId: string
): Promise<string> {
  if (!DISCORD_BOT_TOKEN) return text;

  let validatedGuildId: string;
  try {
    validatedGuildId = parseDiscordSnowflake(guildId, 'guild ID');
  } catch {
    return text;
  }

  const mentionRegex = /<@!?(\d+)>/g;
  const mentions = [...text.matchAll(mentionRegex)];
  if (mentions.length === 0) return text;

  // Deduplicate user IDs
  const uniqueUserIds = [...new Set(mentions.map(m => m[1]).filter(isDiscordSnowflake))];

  // Fetch display names in parallel
  const nameMap = new Map<string, string>();
  await Promise.all(
    uniqueUserIds.map(async userId => {
      try {
        const response = await fetch(
          buildDiscordApiUrl(['guilds', validatedGuildId, 'members', userId]),
          {
            headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
          }
        );
        if (response.ok) {
          const member = (await response.json()) as { nick?: string; user?: { username?: string } };
          const name = member.nick || member.user?.username || userId;
          nameMap.set(userId, name);
        }
      } catch {
        // Silently skip failures -- the mention ID stays in the text
      }
    })
  );

  // Replace all mentions with resolved names
  return text.replace(mentionRegex, (match, userId: string) => {
    const name = nameMap.get(userId);
    return name ? `@${name}` : match;
  });
}

/**
 * Check if a message is from a bot.
 */
export function isDiscordBotMessage(message: { author?: { bot?: boolean } }): boolean {
  return message.author?.bot === true;
}

/**
 * Build a Discord message link.
 */
export function buildDiscordMessageLink(
  guildId: string,
  channelId: string,
  messageId: string
): string {
  const validatedGuildId = parseDiscordSnowflake(guildId, 'guild ID');
  const validatedChannelId = parseDiscordSnowflake(channelId, 'channel ID');
  const validatedMessageId = parseDiscordSnowflake(messageId, 'message ID');
  return `https://discord.com/channels/${validatedGuildId}/${validatedChannelId}/${validatedMessageId}`;
}

/**
 * Discord has a 2000 character message limit. Truncate if needed.
 */
export function truncateForDiscord(text: string, maxLength = 2000): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
