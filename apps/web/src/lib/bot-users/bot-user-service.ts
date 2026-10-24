import 'server-only';

import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organization_memberships, type User } from '@kilocode/db/schema';
import { eq, and, isNull, like } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest, errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import crypto from 'crypto';
import { isUniqueViolation } from '@/lib/db-errors';
import type { BotType } from './types';
import {
  generateBotUserId,
  generateBotUserEmail,
  getBotDisplayName,
  INTERNAL_BOT_SLUG_PATTERN,
  INTERNAL_BOT_USER_ID_PREFIX,
  internalBotUserEmail,
  internalBotUserId,
} from './types';
import {
  generateOpenRouterDownstreamSafetyIdentifier,
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@kilocode/web-shared/lib/ai-gateway/providerHash';

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

export async function getUnblockedBotUserForOrg(
  organizationId: string,
  botType: BotType
): Promise<User | null> {
  const botId = generateBotUserId(organizationId, botType);
  const [bot] = await db
    .select({ user: kilocode_users })
    .from(kilocode_users)
    .innerJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, kilocode_users.id)
      )
    )
    .where(
      and(
        eq(kilocode_users.id, botId),
        eq(kilocode_users.is_bot, true),
        isNull(kilocode_users.blocked_at),
        isNull(kilocode_users.blocked_reason)
      )
    )
    .limit(1);

  return bot?.user ?? null;
}

type BotUserIdentity = { id: string; email: string; displayName: string };

/**
 * Insert a bot user row. Shared by per-org product bots and internal bots so
 * every bot gets the same pepper, safety identifiers and billing defaults.
 */
async function insertBotUser({ id, email, displayName }: BotUserIdentity): Promise<User> {
  logExceptInTest('[insertBotUser] Creating bot user', { botId: id });

  const [botUser] = await db
    .insert(kilocode_users)
    .values({
      id,
      google_user_email: email,
      google_user_name: displayName,
      google_user_image_url:
        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIyNCIgZmlsbD0iIzY2NjY2NiIvPjwvc3ZnPg==', // Gray circle placeholder
      stripe_customer_id: `bot_stripe_${crypto.randomBytes(8).toString('hex')}`,
      is_bot: true,
      api_token_pepper: crypto.randomBytes(32).toString('hex'), // For JWT signing
      is_admin: false,
      auto_top_up_enabled: false,
      openrouter_upstream_safety_identifier: generateOpenRouterUpstreamSafetyIdentifier(id),
      openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(id),
      vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(id),
    })
    .returning();

  if (!botUser) {
    throw new Error(`Failed to create bot user ${id}`);
  }

  logExceptInTest('[insertBotUser] Bot user created successfully', { botId: id });
  return botUser;
}

/**
 * Ensure bot user is a member of the organization
 * Adds membership if it doesn't exist
 */
async function ensureBotIsOrgMember(botUserId: string, organizationId: string): Promise<void> {
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

  // Add bot as organization member; a concurrent insert of the same pair is a no-op.
  await db
    .insert(organization_memberships)
    .values({
      organization_id: organizationId,
      kilo_user_id: botUserId,
      role: 'member',
    })
    .onConflictDoNothing({
      target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
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

    const [existingBot] = await db
      .select()
      .from(kilocode_users)
      .where(and(eq(kilocode_users.id, botId), eq(kilocode_users.is_bot, true)))
      .limit(1);

    let botUser: User;

    if (existingBot) {
      if (existingBot.blocked_at !== null || existingBot.blocked_reason !== null) {
        throw new Error(`Cannot use blocked bot user ${botId}`);
      }
      logExceptInTest('[ensureBotUserForOrg] Using existing bot user', {
        botId,
        organizationId,
      });
      botUser = existingBot;
    } else {
      botUser = await insertBotUser({
        id: botId,
        email: generateBotUserEmail(organizationId, botType),
        displayName: getBotDisplayName(botType),
      });
    }

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

/** The `bot-internal-<slug>` id is taken by a row that cannot be used as an internal bot. */
export class InternalBotUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalBotUnusableError';
  }
}

async function selectUserById(id: string): Promise<User | undefined> {
  const [user] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, id)).limit(1);
  return user;
}

/**
 * Get or create an internal bot user (`bot-internal-<slug>`) and make it a
 * `member` of the organization. Safe to call repeatedly and concurrently: an
 * existing user or membership is reused. A blocked or non-bot row with the id
 * is refused rather than re-adopted. Returns whether the user row was created.
 */
export async function ensureInternalBotUser(input: {
  slug: string;
  displayName: string;
  organizationId: string;
}): Promise<{ user: User; created: boolean }> {
  if (!INTERNAL_BOT_SLUG_PATTERN.test(input.slug)) {
    throw new Error('Invalid internal bot slug');
  }
  const id = internalBotUserId(input.slug);
  let user = await selectUserById(id);
  let created = false;
  if (!user) {
    try {
      user = await insertBotUser({
        id,
        email: internalBotUserEmail(input.slug),
        displayName: input.displayName,
      });
      created = true;
    } catch (error) {
      // A concurrent create won the insert; reuse its row.
      if (!isUniqueViolation(error)) throw error;
      user = await selectUserById(id);
      if (!user) throw error;
    }
  }

  if (!user.is_bot) {
    throw new InternalBotUnusableError(`User ${id} exists but is not a bot`);
  }
  if (user.blocked_at !== null || user.blocked_reason !== null) {
    throw new InternalBotUnusableError(`Bot user ${id} is blocked`);
  }
  if (!user.api_token_pepper?.trim()) {
    throw new InternalBotUnusableError(`Bot user ${id} has no API token pepper`);
  }

  await ensureBotIsOrgMember(user.id, input.organizationId);
  return { user, created };
}

export async function listInternalBotUsers() {
  return db
    .select({
      id: kilocode_users.id,
      name: kilocode_users.google_user_name,
      email: kilocode_users.google_user_email,
      createdAt: kilocode_users.created_at,
      blockedAt: kilocode_users.blocked_at,
      blockedReason: kilocode_users.blocked_reason,
      organizationId: organization_memberships.organization_id,
      role: organization_memberships.role,
    })
    .from(kilocode_users)
    .leftJoin(
      organization_memberships,
      eq(organization_memberships.kilo_user_id, kilocode_users.id)
    )
    .where(like(kilocode_users.id, `${INTERNAL_BOT_USER_ID_PREFIX}%`))
    .orderBy(kilocode_users.id);
}
