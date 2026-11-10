import 'server-only';
import { z } from 'zod';
import { and, eq, exists, isNull, ne, notExists, or } from 'drizzle-orm';
import { claude_billing_connection_grants, claude_billing_connections } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
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

/**
 * Deletes the Anthropic user profiles behind connections the person created
 * when no other Kilo scope still uses them. A payer shared with another person
 * or shared services keeps its profile.
 */
export async function deleteUserClaudeProfiles(userId: string): Promise<void> {
  const rows = await db
    .select({
      id: claude_billing_connections.id,
      user_profile_id: claude_billing_connections.user_profile_id,
    })
    .from(claude_billing_connections)
    .where(
      and(
        or(
          eq(claude_billing_connections.kilo_user_id, userId),
          exists(
            db
              .select({ id: claude_billing_connection_grants.id })
              .from(claude_billing_connection_grants)
              .where(
                and(
                  eq(
                    claude_billing_connection_grants.payer_connection_id,
                    claude_billing_connections.id
                  ),
                  eq(claude_billing_connection_grants.kilo_user_id, userId)
                )
              )
          )
        ),
        notExists(
          db
            .select({ id: claude_billing_connection_grants.id })
            .from(claude_billing_connection_grants)
            .where(
              and(
                eq(
                  claude_billing_connection_grants.payer_connection_id,
                  claude_billing_connections.id
                ),
                isNull(claude_billing_connection_grants.removed_at),
                or(
                  isNull(claude_billing_connection_grants.kilo_user_id),
                  ne(claude_billing_connection_grants.kilo_user_id, userId)
                )
              )
            )
        )
      )
    );
  if (rows.length === 0) return;
  if (!isClaudeOperatorConfigured()) throw new ClaudeProfileDeletionError(false);

  // The installed SDK has no profile-delete method. Keep the local identifier
  // until deletion succeeds; 404 also covers a delete whose reply was lost.
  for (const row of rows) {
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
}
