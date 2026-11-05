import 'server-only';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { claude_billing_connections } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getClaudeBillingConnection } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import {
  getClaudeOperatorToken,
  isClaudeOperatorConfigured,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { CLAUDE_API_BASE_URL } from '@kilocode/web-shared/lib/auth/claude/config';

/**
 * Deletes the deleted person's own Anthropic user profile.
 *
 * The installed Anthropic SDK has no delete for user profiles, so this request
 * is sent directly and its response validated. The order matters for account
 * erasure: the local row keeps the profile ID until the remote delete succeeds,
 * so `softDeleteUser` can be retried after an outage. Anthropic answers 404 for
 * an unknown or already-deleted profile, which also covers a delete whose reply
 * was lost.
 */
const deleteResponseSchema = z.object({ type: z.literal('user_profile_deleted') });

export async function deletePersonalClaudeProfile(userId: string): Promise<void> {
  const row = await getClaudeBillingConnection({ kind: 'personal', kiloUserId: userId });
  if (!row || !isClaudeOperatorConfigured()) return;

  await db
    .update(claude_billing_connections)
    .set({ status: 'billing_unavailable' })
    .where(eq(claude_billing_connections.id, row.id));

  const response = await fetch(
    `${CLAUDE_API_BASE_URL}/v1/user_profiles/${encodeURIComponent(row.user_profile_id)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await getClaudeOperatorToken()}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`Anthropic user profile delete failed with HTTP ${response.status}`);
  }
  deleteResponseSchema.parse(await response.json());
}
