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
import { classifyHttpStatus } from '@/lib/user/deletion-queue/deletion-http';

const deleteResponseSchema = z.object({ type: z.literal('user_profile_deleted') });

export class ClaudeProfileDeletionError extends Error {
  constructor(readonly retryable: boolean) {
    super('Claude profile cleanup could not complete');
  }
}

export async function deletePersonalClaudeProfile(userId: string): Promise<void> {
  const row = await getClaudeBillingConnection({ kind: 'personal', kiloUserId: userId });
  if (!row) return;
  if (!isClaudeOperatorConfigured()) throw new ClaudeProfileDeletionError(false);

  // The installed SDK has no profile-delete method. Keep the local identifier
  // until deletion succeeds; 404 also covers a delete whose reply was lost.
  const response = await fetch(
    `${CLAUDE_API_BASE_URL}/v1/user_profiles/${encodeURIComponent(row.user_profile_id)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${await getClaudeOperatorToken()}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (response.status !== 404) {
    if (!response.ok) {
      const outcome = classifyHttpStatus(response.status);
      throw new ClaudeProfileDeletionError(
        outcome.kind === 'retry' || outcome.kind === 'rate_limited'
      );
    }
    deleteResponseSchema.parse(await response.json());
  }
  await db
    .update(claude_billing_connections)
    .set({ status: 'billing_unavailable' })
    .where(eq(claude_billing_connections.id, row.id));
}
