import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  organizations,
  organization_memberships,
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
} from '@kilocode/db/schema';
import { eq, and, isNull, asc } from 'drizzle-orm';
import * as z from 'zod';
import { logger } from '../util/logger.js';

export { getWorkerDb, type WorkerDb };

export type UserForToken = Pick<
  typeof kilocode_users.$inferSelect,
  'id' | 'blocked_reason' | 'api_token_pepper'
>;

export type BotUserForToken = {
  id: string;
  api_token_pepper: string;
};

const encryptedSecretSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

export type ResolvedProfileConfig = {
  envVars: Record<string, string>;
  encryptedSecrets: Record<string, z.infer<typeof encryptedSecretSchema>>;
  setupCommands: string[];
};

// Bot user constants — must match kilocode-backend's src/lib/bot-users/types.ts
const WEBHOOK_BOT_ID_PREFIX = 'bot-webhook';
const WEBHOOK_BOT_EMAIL_SUFFIX = 'webhook-bot';
const WEBHOOK_BOT_DISPLAY_NAME = 'Webhook Bot';
const BOT_AVATAR_PLACEHOLDER =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIyNCIgZmlsbD0iIzY2NjY2NiIvPjwvc3ZnPg==';

export function generateBotUserId(organizationId: string): string {
  return `${WEBHOOK_BOT_ID_PREFIX}-${organizationId}`;
}

export function generateBotUserEmail(organizationId: string): string {
  return `${WEBHOOK_BOT_EMAIL_SUFFIX}-${organizationId}@kilocode.internal`;
}

function generateApiTokenPepper(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateBotStripeCustomerId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `bot_stripe_${Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

export async function findUserForToken(db: WorkerDb, userId: string): Promise<UserForToken | null> {
  const rows = await db
    .select({
      id: kilocode_users.id,
      blocked_reason: kilocode_users.blocked_reason,
      api_token_pepper: kilocode_users.api_token_pepper,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  return rows[0] ?? null;
}

export async function organizationExists(db: WorkerDb, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deleted_at)))
    .limit(1);

  return rows.length > 0;
}

export async function ensureBotUserForOrg(db: WorkerDb, orgId: string): Promise<BotUserForToken> {
  const botId = generateBotUserId(orgId);
  const botEmail = generateBotUserEmail(orgId);

  // Try to find existing bot user
  const existingRows = await db
    .select({
      id: kilocode_users.id,
      api_token_pepper: kilocode_users.api_token_pepper,
    })
    .from(kilocode_users)
    .where(and(eq(kilocode_users.id, botId), eq(kilocode_users.is_bot, true)))
    .limit(1);

  if (existingRows.length > 0) {
    const existing = existingRows[0];

    await ensureBotIsOrgMember(db, existing.id, orgId);

    if (existing.api_token_pepper) {
      return { id: existing.id, api_token_pepper: existing.api_token_pepper };
    }

    // Edge case: existing bot has NULL api_token_pepper — generate one
    const newPepper = generateApiTokenPepper();
    await db
      .update(kilocode_users)
      .set({ api_token_pepper: newPepper })
      .where(eq(kilocode_users.id, existing.id));

    return { id: existing.id, api_token_pepper: newPepper };
  }

  // Create new bot user
  const apiTokenPepper = generateApiTokenPepper();
  const stripeCustomerId = generateBotStripeCustomerId();

  await db.insert(kilocode_users).values({
    id: botId,
    google_user_email: botEmail,
    google_user_name: WEBHOOK_BOT_DISPLAY_NAME,
    google_user_image_url: BOT_AVATAR_PLACEHOLDER,
    stripe_customer_id: stripeCustomerId,
    is_bot: true,
    api_token_pepper: apiTokenPepper,
  });

  await ensureBotIsOrgMember(db, botId, orgId);

  return { id: botId, api_token_pepper: apiTokenPepper };
}

async function ensureBotIsOrgMember(db: WorkerDb, botUserId: string, orgId: string) {
  const existingRows = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, orgId),
        eq(organization_memberships.kilo_user_id, botUserId)
      )
    )
    .limit(1);

  if (existingRows.length > 0) return;

  await db.insert(organization_memberships).values({
    id: crypto.randomUUID(),
    organization_id: orgId,
    kilo_user_id: botUserId,
    role: 'member',
  });
}

export async function resolveProfile(
  db: WorkerDb,
  profileId: string,
  ownerUserId?: string | null,
  ownerOrgId?: string | null
): Promise<ResolvedProfileConfig | null> {
  const profiles = await db
    .select({
      id: agent_environment_profiles.id,
      owned_by_organization_id: agent_environment_profiles.owned_by_organization_id,
      owned_by_user_id: agent_environment_profiles.owned_by_user_id,
    })
    .from(agent_environment_profiles)
    .where(eq(agent_environment_profiles.id, profileId))
    .limit(1);

  const profile = profiles[0];
  if (!profile) return null;

  // Validate ownership
  if (ownerOrgId) {
    if (profile.owned_by_organization_id !== ownerOrgId) return null;
  } else if (ownerUserId) {
    if (profile.owned_by_user_id !== ownerUserId) return null;
  }

  const [vars, commands] = await Promise.all([
    db
      .select({
        key: agent_environment_profile_vars.key,
        value: agent_environment_profile_vars.value,
        is_secret: agent_environment_profile_vars.is_secret,
      })
      .from(agent_environment_profile_vars)
      .where(eq(agent_environment_profile_vars.profile_id, profileId)),

    db
      .select({
        command: agent_environment_profile_commands.command,
      })
      .from(agent_environment_profile_commands)
      .where(eq(agent_environment_profile_commands.profile_id, profileId))
      .orderBy(asc(agent_environment_profile_commands.sequence)),
  ]);

  const envVars: Record<string, string> = {};
  const encryptedSecrets: ResolvedProfileConfig['encryptedSecrets'] = {};

  for (const variable of vars) {
    if (variable.is_secret) {
      try {
        encryptedSecrets[variable.key] = encryptedSecretSchema.parse(JSON.parse(variable.value));
      } catch {
        // Skip malformed secrets
        logger.error('Failed to parse encrypted secret', {
          profileId,
          key: variable.key,
        });
      }
    } else {
      envVars[variable.key] = variable.value;
    }
  }

  return {
    envVars,
    encryptedSecrets,
    setupCommands: commands.map(c => c.command),
  };
}
