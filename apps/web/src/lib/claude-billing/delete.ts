import 'server-only';
import { z } from 'zod';
import { and, eq, exists, isNull, ne, notExists, or } from 'drizzle-orm';
import { claude_billing_connection_grants, claude_billing_connections } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  getClaudeOperatorToken,
  isClaudeOperatorConfigured,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import type { UnreferencedClaudeBillingPayer } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { CLAUDE_API_BASE_URL } from '@kilocode/web-shared/lib/auth/claude/config';
import { classifyHttpStatus } from '@/lib/user/deletion-queue/deletion-http';

const deleteResponseSchema = z.object({ type: z.literal('user_profile_deleted') });

export class ClaudeProfileDeletionError extends Error {
  constructor(readonly retryable: boolean) {
    super('Claude profile cleanup could not complete');
  }
}
function operatorConfigured(): boolean {
  return typeof isClaudeOperatorConfigured === 'function' && isClaudeOperatorConfigured();
}

async function deleteClaudeUserProfileRemote(userProfileId: string): Promise<void> {
  const response = await fetch(
    `${CLAUDE_API_BASE_URL}/v1/user_profiles/${encodeURIComponent(userProfileId)}`,
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
  if (response.status === 404) return;
  if (!response.ok) {
    const outcome = classifyHttpStatus(response.status);
    throw new ClaudeProfileDeletionError(
      outcome.kind === 'retry' || outcome.kind === 'rate_limited'
    );
  }
  deleteResponseSchema.parse(await response.json());
}

export async function retireUnreferencedClaudeBillingPayer(
  payer: UnreferencedClaudeBillingPayer
): Promise<void> {
  if (!operatorConfigured()) return;
  await deleteClaudeUserProfileRemote(payer.userProfileId);
  await db.delete(claude_billing_connections).where(
    and(
      eq(claude_billing_connections.id, payer.id),
      eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Removed),
      notExists(
        db
          .select({ id: claude_billing_connection_grants.id })
          .from(claude_billing_connection_grants)
          .where(
            and(
              eq(claude_billing_connection_grants.payer_connection_id, payer.id),
              isNull(claude_billing_connection_grants.removed_at)
            )
          )
      )
    )
  );
}

export async function cleanupRemovedClaudeProfilesForUser(userId: string): Promise<void> {
  if (!operatorConfigured()) return;
  const rows = await db
    .select({
      id: claude_billing_connections.id,
      userProfileId: claude_billing_connections.user_profile_id,
    })
    .from(claude_billing_connections)
    .where(
      and(
        eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Removed),
        or(
          eq(claude_billing_connections.kilo_user_id, userId),
          eq(claude_billing_connections.created_by, userId),
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
                isNull(claude_billing_connection_grants.removed_at)
              )
            )
        )
      )
    );
  for (const row of rows) {
    await retireUnreferencedClaudeBillingPayer(row);
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
          and(
            eq(claude_billing_connections.created_by, userId),
            eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Removed)
          ),
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
  if (!operatorConfigured()) throw new ClaudeProfileDeletionError(false);

  for (const row of rows) {
    await deleteClaudeUserProfileRemote(row.user_profile_id);
    await db
      .update(claude_billing_connections)
      .set({ status: 'billing_unavailable' })
      .where(eq(claude_billing_connections.id, row.id));
  }
}
