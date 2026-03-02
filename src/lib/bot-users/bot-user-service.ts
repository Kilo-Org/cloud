import 'server-only';

import { db } from '@/lib/drizzle';
import { kilocode_users, organization_memberships, type User } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import crypto from 'crypto';
import type { BotType } from './types';
import { generateBotUserId, generateBotUserEmail, getBotDisplayName } from './types';
import { generateOpenRouterUpstreamSafetyIdentifier } from '@/lib/providerHash';

/**
 * Get the user ID of a bot for an organization
 * Returns null if bot user doesn't exist
 */
export async function getBotUserId(
  organizationId: string,
  botType: BotType
): Promise<string | null> {
  const botId = generateBotUserId(organizationId, botType);

  const [bot] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(and(eq(kilocode_users.id, botId), eq(kilocode_users.is_bot, true)))
    .limit(1);

  return bot?.id ?? null;
}

/**
 * Create a bot user for an organization
 * Returns the created user
 */
async function createBotUser(organizationId: string, botType: BotType): Promise<User> {
  const botId = generateBotUserId(organizationId, botType);
  const botEmail = generateBotUserEmail(organizationId, botType);
  const botName = getBotDisplayName(botType);

  logExceptInTest('[createBotUser] Creating bot user', {
    botId,
    organizationId,
    botType,
  });

  // Create bot user with minimal required fields
  const [botUser] = await db
    .insert(kilocode_users)
    .values({
      id: botId,
      google_user_email: botEmail,
      google_user_name: botName,
      google_user_image_url:
        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIyNCIgZmlsbD0iIzY2NjY2NiIvPjwvc3ZnPg==', // Gray circle placeholder
      stripe_customer_id: `bot_stripe_${crypto.randomBytes(8).toString('hex')}`,
      is_bot: true,
      api_token_pepper: crypto.randomBytes(32).toString('hex'), // For JWT signing
      is_admin: false,
      auto_top_up_enabled: false,
      openrouter_upstream_safety_identifier: generateOpenRouterUpstreamSafetyIdentifier(botId),
    })
    .returning();

  if (!botUser) {
    throw new Error(`Failed to create bot user ${botId}`);
  }

  logExceptInTest('[createBotUser] Bot user created successfully', { botId });
  return botUser;
}

/**
 * Ensure bot user is a member of the organization
 * Adds membership if it doesn't exist
 */
async function ensureBotIsOrgMember(botUserId: string, organizationId: string): Promise<void> {
  // Check if membership already exists
  const [existing] = await db
    .select()
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, botUserId)
      )
    )
    .limit(1);

  if (existing) {
    logExceptInTest('[ensureBotIsOrgMember] Bot is already an org member', {
      botUserId,
      organizationId,
    });
    return;
  }

  // Add bot as organization member
  await db.insert(organization_memberships).values({
    organization_id: organizationId,
    kilo_user_id: botUserId,
    role: 'member',
  });

  logExceptInTest('[ensureBotIsOrgMember] Added bot to organization', {
    botUserId,
    organizationId,
  });
}

/**
 * Get or create a bot user for an organization and ensure it's a member
 * This is the main function to use when you need a bot user
 */
export async function ensureBotUserForOrg(organizationId: string, botType: BotType): Promise<User> {
  try {
    const botId = generateBotUserId(organizationId, botType);

    // Try to get existing bot user
    const [existingBot] = await db
      .select()
      .from(kilocode_users)
      .where(and(eq(kilocode_users.id, botId), eq(kilocode_users.is_bot, true)))
      .limit(1);

    let botUser: User;

    if (existingBot) {
      logExceptInTest('[ensureBotUserForOrg] Using existing bot user', {
        botId,
        organizationId,
      });
      botUser = existingBot;
    } else {
      // Create new bot user
      botUser = await createBotUser(organizationId, botType);
    }

    // Ensure bot is org member
    await ensureBotIsOrgMember(botUser.id, organizationId);

    return botUser;
  } catch (error) {
    errorExceptInTest('[ensureBotUserForOrg] Failed to ensure bot user', {
      organizationId,
      botType,
      error,
    });
    captureException(error, {
      tags: { operation: 'ensure-bot-user' },
      extra: { organizationId, botType },
    });
    throw error;
  }
}
