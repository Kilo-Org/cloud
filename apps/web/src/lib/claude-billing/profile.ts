import 'server-only';
import { sql } from 'drizzle-orm';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createClaudeUserProfile } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import {
  claudeBillingOwnerKey,
  getGrantedClaudeBillingConnection,
  insertClaudeBillingProfile,
  type ClaudeBillingOwner,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { cleanupRemovedClaudeProfilesForUser } from '@/lib/claude-billing/delete';

/**
 * Resolves the Anthropic user profile for an OAuth link attempt. An active or
 * pending scope reuses its profile; an unlinked scope gets a fresh profile so a
 * person can link different Claude organizations across scopes.
 */
export async function ensureClaudeBillingProfile(
  owner: ClaudeBillingOwner,
  createdBy: string
): Promise<{ userProfileId: string; connectionVersion: string }> {
  await cleanupRemovedClaudeProfilesForUser(createdBy, { limit: 3, timeoutMs: 3_000 }).catch(
    () => undefined
  );
  const lockKey = claudeBillingOwnerKey(owner);

  return await db.transaction(async tx => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`claude_billing_profile:${lockKey}`}))`
    );
    const active = await getGrantedClaudeBillingConnection(owner, tx);
    if (active && active.status !== ClaudeBillingConnectionStatus.Removed) {
      return { userProfileId: active.user_profile_id, connectionVersion: active.updated_at };
    }

    const userProfileId = await createClaudeUserProfile();
    const row = await insertClaudeBillingProfile(owner, userProfileId, createdBy, tx);
    return { userProfileId: row.user_profile_id, connectionVersion: row.updated_at };
  });
}
