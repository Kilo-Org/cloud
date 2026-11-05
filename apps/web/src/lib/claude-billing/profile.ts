import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createClaudeUserProfile } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import {
  getClaudeBillingConnection,
  insertClaudeBillingProfile,
  type ClaudeBillingOwner,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';

/**
 * The owner's Anthropic user profile, created once and reused after that. The
 * profile is how Anthropic knows which customer a billed request is for, and
 * `POST /v1/user_profiles` creates a new profile on every call, so a
 * per-owner advisory lock keeps two concurrent connects from creating two.
 */
export async function ensureClaudeBillingProfile(
  owner: ClaudeBillingOwner,
  createdBy: string
): Promise<string> {
  const lockKey =
    owner.kind === 'organization' ? `org:${owner.organizationId}` : `user:${owner.kiloUserId}`;

  return await db.transaction(async tx => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`claude_billing_profile:${lockKey}`}))`
    );
    const existing = await getClaudeBillingConnection(owner, tx);
    if (existing) return existing.user_profile_id;

    const userProfileId = await createClaudeUserProfile();
    const row = await insertClaudeBillingProfile(owner, userProfileId, createdBy, tx);
    return row.user_profile_id;
  });
}
