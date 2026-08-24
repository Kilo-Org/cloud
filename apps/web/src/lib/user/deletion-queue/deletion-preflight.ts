import { and, eq, inArray, sql } from 'drizzle-orm';
import { kilocode_users, user_deletion_requests, type User } from '@kilocode/db/schema';
import { UserDeletionRequestStatus } from '@kilocode/db/schema-types';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { db } from '@/lib/drizzle';
import { assertNoLiveSubscriptionsForSoftDelete, SoftDeletePreconditionError } from '@/lib/user';
import { persistPreflightOutcomeTx } from '@/lib/user/deletion-queue/deletion-outcomes';
import { classifyCloudSubject } from '@/lib/user/deletion-queue/deletion-enqueue';
import {
  deletionAdvisoryLockKey,
  hmacDeletionEmail,
} from '@/lib/user/deletion-queue/deletion-hmac';
import {
  classifyProtectedIdentity,
  isBlockedDeletionTargetEmail,
  normalizeDeletionEmail,
} from '@/lib/user/deletion-queue/deletion-intake';
import { resolveTicketEmail } from '@/lib/user/deletion-queue/deletion-ticket-resolve';
import {
  ACTIVE_REQUEST_STATUSES,
  type DeletionPreflightOutcome,
} from '@/lib/user/deletion-queue/deletion-types';

export type PreflightResult =
  | { kind: 'promoted'; userId: string | null }
  | { kind: 'attention'; code: string }
  | { kind: 'skipped'; reason: 'not_pending' | 'not_found' | 'already_blocked' | 'retryable' };

export async function runDeletionPreflight(requestId: string): Promise<PreflightResult> {
  const [snapshot] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, requestId));
  if (!snapshot) return { kind: 'skipped', reason: 'not_found' };
  if (snapshot.status !== UserDeletionRequestStatus.Pending) {
    return { kind: 'skipped', reason: 'not_pending' };
  }
  if (snapshot.preflight_attention_code) {
    return { kind: 'skipped', reason: 'already_blocked' };
  }

  let resolvedTicketEmail: string | null = null;
  if (!snapshot.target_email && snapshot.pylon_ticket_ref) {
    const resolved = await resolveTicketEmail(snapshot.pylon_ticket_ref);
    if (resolved.kind === 'retryable') {
      await db
        .update(user_deletion_requests)
        .set({ last_progress_at: sql`now()` })
        .where(eq(user_deletion_requests.id, requestId));
      return { kind: 'skipped', reason: 'retryable' };
    }
    if (resolved.kind === 'attention') {
      return persistOutcome(requestId, { kind: 'needs_attention', errorCode: resolved.code });
    }
    resolvedTicketEmail = resolved.email;
  }

  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId))
      .for('update');
    if (!request) return { kind: 'skipped', reason: 'not_found' };

    if (
      resolvedTicketEmail &&
      request.status === UserDeletionRequestStatus.Pending &&
      !request.target_email
    ) {
      const applied = await applyResolvedTicketEmail(tx, request, resolvedTicketEmail);
      if (applied.kind !== 'applied') {
        const persisted = await persistPreflightOutcomeTx(tx, request, applied);
        return toPreflightResult(persisted.kind === 'skipped' ? persisted : applied);
      }
    }

    const [fresh] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId))
      .for('update');
    if (!fresh) return { kind: 'skipped', reason: 'not_found' };

    const outcome = await evaluateDeletionPreflight(tx, fresh);
    const persisted = await persistPreflightOutcomeTx(tx, fresh, outcome);
    return toPreflightResult(persisted.kind === 'skipped' ? persisted : outcome);
  });
}

async function persistOutcome(
  requestId: string,
  outcome: DeletionPreflightOutcome
): Promise<PreflightResult> {
  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId))
      .for('update');
    if (!request) return { kind: 'skipped' as const, reason: 'not_found' as const };
    if (request.status !== UserDeletionRequestStatus.Pending) {
      return { kind: 'skipped' as const, reason: 'not_pending' as const };
    }
    if (request.preflight_attention_code) {
      return { kind: 'skipped' as const, reason: 'already_blocked' as const };
    }
    const persisted = await persistPreflightOutcomeTx(tx, request, outcome);
    return toPreflightResult(persisted.kind === 'skipped' ? persisted : outcome);
  });
}

async function applyResolvedTicketEmail(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  request: typeof user_deletion_requests.$inferSelect,
  email: string
): Promise<{ kind: 'applied' } | DeletionPreflightOutcome> {
  if (isBlockedDeletionTargetEmail(email)) {
    return { kind: 'needs_attention', errorCode: 'relay_or_internal_email' };
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${deletionAdvisoryLockKey(email).toString()}::int8)`
  );

  const hmac = hmacDeletionEmail(email);
  const [collision] = await tx
    .select({ id: user_deletion_requests.id })
    .from(user_deletion_requests)
    .where(
      and(
        eq(user_deletion_requests.target_email_hmac, hmac),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES)
      )
    )
    .limit(1);
  if (collision && collision.id !== request.id) {
    return { kind: 'needs_attention', errorCode: 'duplicate_of_active_request' };
  }

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
  const subject = await classifyCloudSubject(tx, { email, currentUser });
  await tx
    .update(user_deletion_requests)
    .set({
      target_email: email,
      target_email_hmac: hmac,
      user_id: subject.userId,
      cloud_subject_resolution: subject.resolution,
      cloud_subject_proof_ref: subject.proofRef,
    })
    .where(eq(user_deletion_requests.id, request.id));
  return { kind: 'applied' };
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
  if (isBlockedDeletionTargetEmail(request.target_email)) {
    return { kind: 'needs_attention', errorCode: 'relay_or_internal_email' };
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
    actor: {
      id: request.requested_by_kilo_user_id,
      email: request.requested_by_email,
    },
    allowSelf: Boolean(
      !request.pylon_ticket_ref &&
      adoptedUser &&
      request.requested_by_kilo_user_id === adoptedUser.id
    ),
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
