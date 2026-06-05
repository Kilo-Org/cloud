import { DISCORD_OAUTH_BOT_TOKEN, DISCORD_SERVER_ID } from '@/lib/config.server';
import { buildDiscordApiUrl, parseDiscordSnowflake } from '@/lib/discord-bot/discord-id';

/**
 * Check if a Discord user is a member of the Kilo Discord server.
 * Uses the DISCORD_OAUTH_BOT_TOKEN — the bot from the OAuth app must be invited
 * to the Kilo Discord server (no permissions needed, just guild presence).
 *
 * Returns true if the user is a guild member, false if not (404), and
 * throws on unexpected API errors.
 */
export async function checkDiscordGuildMembership(discordUserId: string): Promise<boolean> {
  if (!DISCORD_OAUTH_BOT_TOKEN || !DISCORD_SERVER_ID) {
    throw new Error('DISCORD_OAUTH_BOT_TOKEN or DISCORD_SERVER_ID not configured');
  }

  const guildId = parseDiscordSnowflake(DISCORD_SERVER_ID, 'server ID');
  const userId = parseDiscordSnowflake(discordUserId, 'user ID');

  const response = await fetch(buildDiscordApiUrl(['guilds', guildId, 'members', userId]), {
    headers: {
      Authorization: `Bot ${DISCORD_OAUTH_BOT_TOKEN}`,
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (response.ok) return true;
  if (response.status === 404) return false;

  throw new Error(`Discord API error: ${response.status} ${response.statusText}`);
}
