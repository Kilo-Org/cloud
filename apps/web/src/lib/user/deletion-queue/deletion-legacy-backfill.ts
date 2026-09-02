import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { kilocode_users, user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionAuditEventType,
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { SOFT_DELETED_BLOCK_REASON_PREFIX } from '@kilocode/db/user-soft-delete-reasons';
import { db } from '@/lib/drizzle';
import { assertNoLiveSubscriptionsForSoftDelete, SoftDeletePreconditionError } from '@/lib/user';
import { writeDeletionAudit } from '@/lib/user/deletion-queue/deletion-audit';
import { catalogForVersion } from '@/lib/user/deletion-queue/deletion-catalog';
import { USER_DELETION_ID_ONLY_CATALOG_VERSION } from '@/lib/user/deletion-queue/deletion-constants';
import {
  deletionAdvisoryLockKey,
  hmacDeletionEmail,
  hmacResourceRef,
} from '@/lib/user/deletion-queue/deletion-hmac';
import { normalizeDeletionEmail } from '@/lib/user/deletion-queue/deletion-intake';
import { ACTIVE_REQUEST_STATUSES } from '@/lib/user/deletion-queue/deletion-types';

const BACKFILL_CODE = 'user_id_only_backfill_2026_08_26';

export type BackfillResult =
  | { status: 'eligible' }
  | { status: 'enqueued'; requestId: string }
  | { status: 'existing'; requestId: string; requestStatus: UserDeletionRequestStatus }
  | { status: 'refused'; code: string; requestId?: string };

export async function enqueueHistoricalUserDeletion(params: {
  userId: string;
  adminUserId: string;
  execute?: boolean;
}): Promise<BackfillResult> {
  const syntheticEmail = `deleted+${params.userId}@deleted.invalid`;
  const email = normalizeDeletionEmail(syntheticEmail);
  const targetEmailHmac = hmacDeletionEmail(email);
  const proofRef = `${BACKFILL_CODE}:${hmacResourceRef(`${BACKFILL_CODE}:${params.userId}`)}`;

  return db.transaction(async tx => {
    const [admin] = await tx
      .select({
        is_admin: kilocode_users.is_admin,
        is_super_admin: kilocode_users.is_super_admin,
        blocked_reason: kilocode_users.blocked_reason,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, params.adminUserId))
      .limit(1);
    if (!admin || (!admin.is_admin && !admin.is_super_admin) || admin.blocked_reason !== null) {
      return { status: 'refused', code: 'active_admin_required' };
    }

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${deletionAdvisoryLockKey(email).toString()}::int8)`
    );
    const [user] = await tx
      .select({
        id: kilocode_users.id,
        google_user_email: kilocode_users.google_user_email,
        blocked_reason: kilocode_users.blocked_reason,
        is_bot: kilocode_users.is_bot,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, params.userId))
      .for('update')
      .limit(1);
    if (!user) return { status: 'refused', code: 'user_not_found' };
    if (
      user.google_user_email !== syntheticEmail ||
      !user.blocked_reason?.startsWith(SOFT_DELETED_BLOCK_REASON_PREFIX)
    ) {
      return { status: 'refused', code: 'not_canonical_soft_deleted_user' };
    }
    if (user.is_bot) return { status: 'refused', code: 'protected_bot' };

    const timestamp = user.blocked_reason.slice(SOFT_DELETED_BLOCK_REASON_PREFIX.length);
    const deletedAt = new Date(timestamp);
    if (Number.isNaN(deletedAt.getTime()) || deletedAt.toISOString() !== timestamp) {
      return { status: 'refused', code: 'invalid_deletion_timestamp' };
    }

    const [existing] = await tx
      .select({ id: user_deletion_requests.id, status: user_deletion_requests.status })
      .from(user_deletion_requests)
      .where(
        and(
          eq(user_deletion_requests.target_email_hmac, targetEmailHmac),
          eq(user_deletion_requests.cloud_subject_proof_ref, proofRef),
          eq(user_deletion_requests.catalog_version, USER_DELETION_ID_ONLY_CATALOG_VERSION)
        )
      )
      .limit(1);
    if (existing) {
      return { status: 'existing', requestId: existing.id, requestStatus: existing.status };
    }

    const [active] = await tx
      .select({ id: user_deletion_requests.id })
      .from(user_deletion_requests)
      .where(
        and(
          inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES),
          or(
            eq(user_deletion_requests.user_id, user.id),
            eq(user_deletion_requests.target_email_hmac, targetEmailHmac)
          )
        )
      )
      .limit(1);
    if (active) {
      return { status: 'refused', code: 'active_deletion_request', requestId: active.id };
    }

    try {
      await assertNoLiveSubscriptionsForSoftDelete(user.id, tx);
    } catch (error) {
      if (error instanceof SoftDeletePreconditionError) {
        return { status: 'refused', code: 'live_subscription' };
      }
      throw error;
    }
    if (!params.execute) return { status: 'eligible' };

    const [request] = await tx
      .insert(user_deletion_requests)
      .values({
        user_id: user.id,
        status: UserDeletionRequestStatus.InProgress,
        catalog_version: USER_DELETION_ID_ONLY_CATALOG_VERSION,
        requested_by_kilo_user_id: params.adminUserId,
        target_email: syntheticEmail,
        target_email_hmac: targetEmailHmac,
        cloud_subject_resolution: UserDeletionCloudSubjectResolution.CurrentUser,
        cloud_subject_proof_ref: proofRef,
      })
      .returning({ id: user_deletion_requests.id });
    if (!request) throw new Error('Failed to create historical deletion request');

    await tx.insert(user_deletion_steps).values(
      catalogForVersion(USER_DELETION_ID_ONLY_CATALOG_VERSION).map(({ stepKey }) => ({
        request_id: request.id,
        step_key: stepKey,
        status: UserDeletionStepStatus.Pending,
      }))
    );
    await writeDeletionAudit(tx, {
      requestId: request.id,
      eventType: UserDeletionAuditEventType.RequestCreated,
      actorKiloUserId: params.adminUserId,
      targetEmailHmac,
      subjectKey: 'request',
      details: { catalog_version: USER_DELETION_ID_ONLY_CATALOG_VERSION, code: BACKFILL_CODE },
    });
    return { status: 'enqueued', requestId: request.id };
  });
}
