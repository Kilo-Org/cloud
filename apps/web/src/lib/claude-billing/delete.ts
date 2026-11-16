import 'server-only';
import { z } from 'zod';
import { and, eq, exists, isNull, ne, notExists, or } from 'drizzle-orm';
import { claude_billing_connection_grants, claude_billing_connections } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  getClaudeOperatorToken,
  isClaudeOperatorConfigured,
  unlinkClaudeUserProfile,
  type ClaudeUserProfileUnlinkResult,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import {
  findRetiringClaudeBillingPayer,
  liveClaudeBillingGrantWhere,
  removeClaudeBillingGrant,
  withClaudeBillingPayerLock,
  type ClaudeBillingOwner,
  type UnreferencedClaudeBillingPayer,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
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

async function deleteClaudeUserProfileRemote(
  userProfileId: string,
  timeoutMs = 15_000
): Promise<void> {
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
      signal: AbortSignal.timeout(timeoutMs),
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

/**
 * Ends Kilo's link at Anthropic before the profile behind it is deleted, because
 * deleting the profile leaves the customer's Claude organization linked to Kilo.
 * A retryable failure keeps the row and its profile identifier for a later run;
 * a refusal that no retry can fix leaves the row in place for a later attempt
 * instead of blocking the caller; a missing profile holds no link, so the delete
 * goes ahead.
 */
async function unlinkBeforeProfileDelete(userProfileId: string, timeoutMs: number): Promise<void> {
  const unlink = await unlinkClaudeUserProfile(userProfileId, timeoutMs);
  if (unlink.kind === 'retry') throw new ClaudeProfileDeletionError(true);
  if (unlink.kind === 'needs_console') throw new ClaudeProfileDeletionError(false);
}

export async function retireUnreferencedClaudeBillingPayer(
  payer: UnreferencedClaudeBillingPayer,
  options: {
    timeoutMs?: number;
    /** Set false when the caller already ended this payer's link. */
    unlink?: boolean;
  } = {}
): Promise<void> {
  if (!operatorConfigured()) return;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (options.unlink ?? true) await unlinkBeforeProfileDelete(payer.userProfileId, timeoutMs);
  await deleteClaudeUserProfileRemote(payer.userProfileId, timeoutMs);
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
              liveClaudeBillingGrantWhere()
            )
          )
      )
    )
  );
}

export type ClaudeBillingRemoval = {
  unlink: ClaudeUserProfileUnlinkResult;
  /** The payer to delete at Anthropic and locally, when no grant keeps it. */
  unreferencedPayer: UnreferencedClaudeBillingPayer | null;
};

const NO_UNLINK: ClaudeUserProfileUnlinkResult = { kind: 'unlinked', revokedConnectionIds: [] };

/**
 * Ends Kilo's link at Anthropic for the payer this scope would retire, then
 * removes the scope's grant. Both run under the payer lock that sharing takes,
 * so a grant cannot appear or vanish around the unlink: the scope that keeps the
 * payer keeps its link, and a scope that retires it never leaves the link behind.
 */
export async function unlinkAndRemoveClaudeBillingGrant(
  owner: ClaudeBillingOwner,
  timeoutMs = 15_000
): Promise<ClaudeBillingRemoval> {
  if (!operatorConfigured()) {
    return { unlink: NO_UNLINK, unreferencedPayer: await removeClaudeBillingGrant(owner) };
  }
  return await withClaudeBillingPayerLock(owner, async tx => {
    const retiring = await findRetiringClaudeBillingPayer(owner, tx);
    const unlink = retiring
      ? await unlinkClaudeUserProfile(retiring.userProfileId, timeoutMs)
      : NO_UNLINK;
    if (unlink.kind !== 'unlinked') return { unlink, unreferencedPayer: null };
    return { unlink, unreferencedPayer: await removeClaudeBillingGrant(owner, tx) };
  });
}

export async function cleanupRemovedClaudeProfilesForUser(
  userId: string,
  options: { limit?: number; timeoutMs?: number } = {}
): Promise<void> {
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
                liveClaudeBillingGrantWhere()
              )
            )
        )
      )
    )
    .limit(options.limit ?? 10);
  const timeoutMs = options.timeoutMs ?? 15_000;
  await Promise.allSettled(
    rows.map(row => retireUnreferencedClaudeBillingPayer(row, { timeoutMs }))
  );
}
/**
 * Ends Kilo's link at Anthropic for every profile this person's connections own,
 * before the profile is deleted, so the customer's Claude organization does not
 * stay linked to Kilo after the account is gone. A payer shared with another
 * person or shared services keeps its profile.
 *
 * A retryable unlink failure keeps the rows and their profile identifiers and
 * reports a retryable `ClaudeProfileDeletionError`, so the deletion queue tries
 * again. A refused unlink reports a non-retryable one: the rows stay for a later
 * attempt rather than blocking the deletion forever.
 */
export async function deleteUserClaudeProfiles(userId: string): Promise<void> {
  const rows = await db
    .select({
      id: claude_billing_connections.id,
      status: claude_billing_connections.status,
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
                liveClaudeBillingGrantWhere(),
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
    if (row.status === ClaudeBillingConnectionStatus.Removed) {
      await retireUnreferencedClaudeBillingPayer({
        id: row.id,
        userProfileId: row.user_profile_id,
      });
    } else {
      await unlinkBeforeProfileDelete(row.user_profile_id, 15_000);
      await deleteClaudeUserProfileRemote(row.user_profile_id);
      await db
        .update(claude_billing_connections)
        .set({ status: 'billing_unavailable' })
        .where(eq(claude_billing_connections.id, row.id));
    }
  }
}
