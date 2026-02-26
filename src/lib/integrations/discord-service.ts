import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@/db/schema';
import { platform_integrations } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';

// Discord OAuth2 scopes for the bot integration
// 'bot' scope is needed for the bot to join servers
// 'guilds' scope allows reading basic guild info
const DISCORD_SCOPES = ['bot', 'guilds', 'applications.commands'];

// Discord bot permissions (bitfield)
// Includes: Send Messages, Read Message History, Add Reactions, Use Slash Commands, Embed Links, Attach Files
const DISCORD_BOT_PERMISSIONS = '277025770560';

const DISCORD_REDIRECT_URI = `${APP_URL}/api/integrations/discord/callback`;

/**
 * Discord OAuth2 token response shape
 */
export type DiscordOAuth2Response = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  guild?: {
    id: string;
    name: string;
    icon: string | null;
  };
};

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

/**
 * Get Discord OAuth URL for initiating the OAuth flow
 */
export function getDiscordOAuthUrl(state: string): string {
  if (!DISCORD_CLIENT_ID) {
    throw new Error('DISCORD_CLIENT_ID is not configured');
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    permissions: DISCORD_BOT_PERMISSIONS,
    scope: DISCORD_SCOPES.join(' '),
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    state,
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange OAuth code for access token
 */
export async function exchangeDiscordCode(code: string): Promise<DiscordOAuth2Response> {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    throw new Error('Discord OAuth credentials are not configured');
  }

  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord OAuth error: ${errorText}`);
  }

  const data = (await response.json()) as DiscordOAuth2Response;

  if (!data.access_token) {
    throw new Error('Discord OAuth error: No access token received');
  }

  return data;
}

/**
 * Get Discord installation for an owner
 */
export async function getInstallation(owner: Owner): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(...getOwnershipConditions(owner), eq(platform_integrations.platform, PLATFORM.DISCORD))
    )
    .limit(1);

  return integration || null;
}

/**
 * Get Discord installation by guild ID
 * Used to identify which Kilo Code user/org owns the installation when receiving Discord events
 */
export async function getInstallationByGuildId(
  guildId: string
): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.DISCORD),
        eq(platform_integrations.platform_installation_id, guildId)
      )
    )
    .limit(1);

  return integration || null;
}

/**
 * Get the owner information from a Discord installation
 */
export function getOwnerFromInstallation(integration: PlatformIntegration): Owner | null {
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

/**
 * Create or update Discord installation from OAuth response
 */
export async function upsertDiscordInstallation(
  owner: Owner,
  oauthResponse: DiscordOAuth2Response
): Promise<PlatformIntegration> {
  if (!oauthResponse.guild?.id) {
    throw new Error(
      'Discord OAuth response did not include guild information. The bot must be added to a server during authorization.'
    );
  }

  const existing = await getInstallation(owner);

  const guildId = oauthResponse.guild.id;
  const guildName = oauthResponse.guild.name || 'Unknown Server';
  const scopes = oauthResponse.scope?.split(' ') || null;

  // Note: We intentionally do NOT store the OAuth2 access_token or refresh_token.
  // Discord's OAuth2 user tokens are short-lived and not used for bot operations.
  // All bot API calls use the DISCORD_BOT_TOKEN env var instead.
  const metadata = {
    guild_icon: oauthResponse.guild.icon,
  };

  if (existing) {
    const [updated] = await db
      .update(platform_integrations)
      .set({
        platform_account_id: guildId,
        platform_account_login: guildName,
        scopes,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, existing.id))
      .returning();

    return updated;
  }

  const [created] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      platform: PLATFORM.DISCORD,
      integration_type: 'oauth',
      platform_installation_id: guildId,
      platform_account_id: guildId,
      platform_account_login: guildName,
      scopes,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata,
      installed_at: new Date().toISOString(),
    })
    .returning();

  return created;
}

/**
 * Uninstall Discord integration for an owner
 */
export async function uninstallApp(owner: Owner) {
  const integration = await getInstallation(owner);

  if (!integration || integration.integration_status !== INTEGRATION_STATUS.ACTIVE) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Discord installation not found',
    });
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

/**
 * Remove only the database row for a Discord integration without revoking the token.
 * Useful for development when you want to re-test the OAuth flow.
 */
export async function removeDbRowOnly(owner: Owner) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Discord installation not found',
    });
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

/**
 * Test Discord connection by verifying the bot can access the guild.
 * Uses the Bot Token (not the OAuth2 user token) since bot operations
 * require `Bot` authorization, and the OAuth2 token from the install
 * flow is short-lived.
 */
export async function testConnection(owner: Owner): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Discord installation found' };
  }

  if (!DISCORD_BOT_TOKEN) {
    return { success: false, error: 'DISCORD_BOT_TOKEN is not configured' };
  }

  const guildId = integration.platform_account_id;
  if (!guildId) {
    return { success: false, error: 'No guild ID found for this installation' };
  }

  try {
    // Verify the bot can access this guild
    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 403 || response.status === 404) {
        return {
          success: false,
          error: 'Bot does not have access to this server. It may have been removed.',
        };
      }
      return { success: false, error: `Discord API error: ${errorText}` };
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}
