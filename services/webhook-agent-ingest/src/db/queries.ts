import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  kiloclaw_instances,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';

export { getWorkerDb, type WorkerDb };

export type UserForToken = Pick<
  typeof kilocode_users.$inferSelect,
  'id' | 'blocked_reason' | 'api_token_pepper'
>;

export type BotUserForToken = {
  id: string;
  api_token_pepper: string;
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

/**
 * Resolve a kiloclaw_instances.id to its sandbox_id, returning null if the
 * instance is missing, destroyed, or not owned by the given user. Used by
 * the webhook-to-chat delivery path to translate a stored trigger config
 * (which holds the instance UUID) into the sandboxId expected by kilo-chat.
 *
 * The userId filter is defense-in-depth: kilo-chat enforces ownership on
 * the post path too, but scoping here means a stale or cross-user
 * instanceId returns a clean "instance not found" instead of resolving to
 * a different user's sandbox and failing downstream with a misleading
 * forbidden.
 */
export async function findActiveSandboxIdForInstance(
  db: WorkerDb,
  instanceId: string,
  userId: string
): Promise<string | null> {
  const rows = await db
    .select({ sandbox_id: kiloclaw_instances.sandbox_id })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.id, instanceId),
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);
  return rows[0]?.sandbox_id ?? null;
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
