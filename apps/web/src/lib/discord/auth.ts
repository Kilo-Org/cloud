import 'server-only';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { generateApiToken } from '@/lib/tokens';
import { findUserById } from '@/lib/user';
import type { Owner } from '@/lib/integrations/core/types';

/**
 * Generate an auth token for the given owner (user or organization).
 * For Discord, we don't have a direct email mapping from Discord users to Kilo users,
 * so org-owned integrations always use a bot user for auth.
 */
export async function getDiscordBotAuthTokenForOwner(
  owner: Owner
): Promise<{ authToken: string; userId: string } | { error: string }> {
  let authToken: string | undefined;
  let userId: string | undefined;

  if (owner.type === 'org') {
    // For organizations, use a dedicated bot user
    const user = await ensureBotUserForOrg(owner.id, 'discord-bot');
    authToken = generateApiToken(user, { botId: 'discord-bot', internalApiUse: true });
    userId = user.id;
  } else {
    const user = await findUserById(owner.id);
    if (user) {
      authToken = generateApiToken(user, { internalApiUse: true });
      userId = user.id;
    }
  }

  if (!authToken || !userId) {
    return { error: `Discord bot user not found for ID: ${owner.id} and type: ${owner.type}` };
  }

  return { authToken, userId };
}
