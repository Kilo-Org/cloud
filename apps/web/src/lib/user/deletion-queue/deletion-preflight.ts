import { eq, sql } from 'drizzle-orm';
import { kilocode_users, user_deletion_requests, type User } from '@kilocode/db/schema';
import { UserDeletionRequestStatus } from '@kilocode/db/schema-types';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { db } from '@/lib/drizzle';
import { assertNoLiveSubscriptionsForSoftDelete, SoftDeletePreconditionError } from '@/lib/user';
import { persistPreflightOutcomeTx } from '@/lib/user/deletion-queue/deletion-outcomes';
import { deletionAdvisoryLockKey } from '@/lib/user/deletion-queue/deletion-hmac';
import {
  classifyProtectedIdentity,
  normalizeDeletionEmail,
} from '@/lib/user/deletion-queue/deletion-intake';
import type { DeletionPreflightOutcome } from '@/lib/user/deletion-queue/deletion-types';

export type PreflightResult =
  | { kind: 'promoted'; userId: string | null }
  | { kind: 'attention'; code: string }
  | { kind: 'skipped'; reason: 'not_pending' | 'not_found' | 'already_blocked' };

export async function runDeletionPreflight(requestId: string): Promise<PreflightResult> {
  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId))
      .for('update');
    if (!request) return { kind: 'skipped', reason: 'not_found' };

    const outcome = await evaluateDeletionPreflight(tx, request);
    const persisted = await persistPreflightOutcomeTx(tx, request, outcome);
    return toPreflightResult(persisted.kind === 'skipped' ? persisted : outcome);
  });
}

async function evaluateDeletionPreflight(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  request: typeof user_deletion_requests.$inferSelect
): Promise<DeletionPreflightOutcome> {
  if (request.status !== UserDeletionRequestStatus.Pending) {
    return { kind: 'skipped', reason: 'not_pending' };
  }
  if (request.preflight_attention_code) {
    return { kind: 'skipped', reason: 'already_blocked' };
  }
  if (!request.target_email) {
    return { kind: 'needs_attention', errorCode: 'missing_target_email' };
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${deletionAdvisoryLockKey(normalizeDeletionEmail(request.target_email)).toString()}::int8)`
  );

  const email = normalizeDeletionEmail(request.target_email);
  const currentUsers = (
    await tx
      .select()
      .from(kilocode_users)
      .where(eq(sql`lower(${kilocode_users.google_user_email})`, email))
  ).filter(user => !isSoftDeletedBlockedReason(user.blocked_reason));

  if (currentUsers.length > 1) {
    return { kind: 'needs_attention', errorCode: 'ambiguous_cloud_identity' };
  }

  const currentUser = currentUsers[0] ?? null;
  if (request.user_id) {
    if (!currentUser || currentUser.id !== request.user_id) {
      return { kind: 'needs_attention', errorCode: 'user_identity_mismatch' };
    }
    if (normalizeDeletionEmail(currentUser.google_user_email) !== email) {
      return { kind: 'needs_attention', errorCode: 'user_identity_mismatch' };
    }
  }

  const adoptedUser = currentUser;
  const refusal = classifyProtectedIdentity({
    email,
    user: adoptedUser,
  });
  if (refusal) {
    return { kind: 'needs_attention', errorCode: refusal };
  }

  if (adoptedUser) {
    try {
      await assertNoLiveSubscriptionsForSoftDelete(adoptedUser.id, tx);
    } catch (error) {
      if (error instanceof SoftDeletePreconditionError) {
        const code = error.message.includes('Kilo Pass')
          ? 'kilo_pass_active'
          : 'kiloclaw_subscription_active';
        return { kind: 'needs_attention', errorCode: code };
      }
      throw error;
    }
  }

  return { kind: 'promoted', adoptedUserId: adoptedUser?.id ?? null };
}

function toPreflightResult(
  outcome:
    | DeletionPreflightOutcome
    | { kind: 'skipped'; reason: 'not_found' | 'not_pending' | 'already_blocked' }
): PreflightResult {
  if (outcome.kind === 'promoted') {
    return { kind: 'promoted', userId: outcome.adoptedUserId };
  }
  if (outcome.kind === 'needs_attention') {
    return { kind: 'attention', code: outcome.errorCode };
  }
  return { kind: 'skipped', reason: outcome.reason };
}

export type { User };
