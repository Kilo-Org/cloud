import { DISCORD_OAUTH_BOT_TOKEN, DISCORD_SERVER_ID } from '@/lib/config.server';

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

  const response = await fetch(
    `https://discord.com/api/v10/guilds/${DISCORD_SERVER_ID}/members/${discordUserId}`,
    {
      headers: {
        Authorization: `Bot ${DISCORD_OAUTH_BOT_TOKEN}`,
      },
      signal: AbortSignal.timeout(5_000),
    }
  );

  if (response.ok) return true;
  if (response.status === 404) return false;

  throw new Error(`Discord API error: ${response.status} ${response.statusText}`);
}
