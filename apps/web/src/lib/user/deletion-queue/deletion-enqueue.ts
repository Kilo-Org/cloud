import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  deleted_user_email_tombstones,
  kilocode_users,
  user_deletion_requests,
  user_deletion_steps,
  type User,
} from '@kilocode/db/schema';
import {
  UserDeletionAuditEventType,
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
  UserDeletionStepKey,
} from '@kilocode/db/schema-types';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { hashNormalizedEmailForDeletionTombstone } from '@/lib/impact/referral';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { normalizeEmail } from '@/lib/utils';
import { catalogForVersion } from '@/lib/user/deletion-queue/deletion-catalog';
import { USER_DELETION_CATALOG_VERSION } from '@/lib/user/deletion-queue/deletion-constants';
import { writeDeletionAudit } from '@/lib/user/deletion-queue/deletion-audit';
import {
  deletionAdvisoryLockKey,
  hmacDeletionEmail,
} from '@/lib/user/deletion-queue/deletion-hmac';
import {
  classifyProtectedIdentity,
  DeletionRefusalCode,
  normalizeDeletionEmail,
  parsePylonTicket,
  type DeletionRefusalCode as RefusalCode,
} from '@/lib/user/deletion-queue/deletion-intake';
import { ACTIVE_REQUEST_STATUSES } from '@/lib/user/deletion-queue/deletion-types';
import { lookupPylonRequesterEmail } from '@/lib/user/deletion-queue/handlers/pylon-client';

export type EnqueueActor = {
  kiloUserId: string | null;
  email?: string | null;
};

export type EnqueueTarget = {
  email?: string;
  pylonTicket?: string;
  trustedUserId?: string;
};

export type EnqueueResult =
  | { status: 'enqueued'; requestId: string }
  | { status: 'already_active'; requestId: string }
  | { status: 'refused'; code: RefusalCode }
  | { status: 'invalid'; code: RefusalCode };

export type CloudSubjectClassification = {
  resolution: UserDeletionCloudSubjectResolution;
  userId: string | null;
  proofRef: string | null;
};

export async function enqueueUserDeletionTargets(params: {
  actor: EnqueueActor;
  targets: EnqueueTarget[];
}): Promise<EnqueueResult[]> {
  const results: EnqueueResult[] = [];
  for (const target of params.targets) {
    results.push(
      await enqueueOneTarget({
        actor: params.actor,
        target,
      })
    );
  }
  return results;
}

async function enqueueOneTarget(params: {
  actor: EnqueueActor;
  target: EnqueueTarget;
}): Promise<EnqueueResult> {
  const ticket = parsePylonTicket(params.target.pylonTicket);
  let pastedEmail = params.target.email?.trim() ?? '';
  if (!pastedEmail.includes('@') && ticket && ticket !== DeletionRefusalCode.MalformedTicket) {
    let resolved: string | null;
    try {
      resolved = await lookupPylonRequesterEmail(ticket);
    } catch {
      return { status: 'invalid', code: DeletionRefusalCode.TicketUnresolved };
    }
    if (!resolved) {
      return { status: 'invalid', code: DeletionRefusalCode.TicketUnresolved };
    }
    pastedEmail = resolved;
  }
  const email = normalizeDeletionEmail(pastedEmail);
  if (!email.includes('@') || email.length > 320) {
    return { status: 'invalid', code: DeletionRefusalCode.MalformedEmail };
  }
  if (ticket === DeletionRefusalCode.MalformedTicket) {
    return { status: 'invalid', code: DeletionRefusalCode.MalformedTicket };
  }

  try {
    return await db.transaction(async tx => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${deletionAdvisoryLockKey(email).toString()}::int8)`
      );

      const writeHmac = hmacDeletionEmail(email);
      const active = await findActiveRequest(tx, email);
      if (active) {
        return { status: 'already_active' as const, requestId: active.id };
      }
      if (ticket) {
        const byTicket = await findActiveRequestByPylonTicket(tx, ticket);
        if (byTicket) {
          return { status: 'already_active' as const, requestId: byTicket.id };
        }
      }

      const currentUsers = await loadCurrentUsersByEmail(tx, email);
      if (currentUsers.length > 1) {
        await writeRefusalAudit(tx, params, writeHmac, DeletionRefusalCode.AmbiguousCloudIdentity);
        return { status: 'refused' as const, code: DeletionRefusalCode.AmbiguousCloudIdentity };
      }

      const currentUser = currentUsers[0] ?? null;
      if (!currentUser) {
        await writeRefusalAudit(tx, params, writeHmac, DeletionRefusalCode.NoCloudUser);
        return { status: 'refused' as const, code: DeletionRefusalCode.NoCloudUser };
      }
      if (params.target.trustedUserId) {
        if (!currentUser || currentUser.id !== params.target.trustedUserId) {
          return { status: 'invalid' as const, code: DeletionRefusalCode.UserHintMismatch };
        }
        if (normalizeDeletionEmail(currentUser.google_user_email) !== email) {
          return { status: 'invalid' as const, code: DeletionRefusalCode.UserHintMismatch };
        }
      }

      const refusal = classifyProtectedIdentity({
        email,
        user: currentUser,
        actor: { id: params.actor.kiloUserId, email: params.actor.email ?? null },
      });
      if (refusal) {
        await writeRefusalAudit(tx, params, writeHmac, refusal);
        return { status: 'refused' as const, code: refusal };
      }

      if (currentUser) {
        const byUser = await findActiveRequestByUserId(tx, currentUser.id);
        if (byUser) {
          return { status: 'already_active' as const, requestId: byUser.id };
        }
      }

      const subject = await classifyCloudSubject(tx, {
        email,
        currentUser,
      });

      const [request] = await tx
        .insert(user_deletion_requests)
        .values({
          user_id: subject.userId,
          status: UserDeletionRequestStatus.Pending,
          catalog_version: USER_DELETION_CATALOG_VERSION,
          requested_by_kilo_user_id: params.actor.kiloUserId,
          target_email: currentUser ? currentUser.google_user_email : pastedEmail,
          target_email_hmac: writeHmac,
          pylon_ticket_ref: ticket,
          cloud_subject_resolution: subject.resolution,
          cloud_subject_proof_ref: subject.proofRef,
        })
        .returning({ id: user_deletion_requests.id });

      if (!request) {
        throw new Error('Failed to insert user deletion request');
      }

      await tx.insert(user_deletion_steps).values(
        catalogForVersion(USER_DELETION_CATALOG_VERSION).map(entry => ({
          request_id: request.id,
          step_key: entry.stepKey,
        }))
      );

      await writeDeletionAudit(tx, {
        requestId: request.id,
        eventType: UserDeletionAuditEventType.RequestCreated,
        actorKiloUserId: params.actor.kiloUserId,
        targetEmailHmac: writeHmac,
        subjectKey: 'request',
        details: { catalog_version: USER_DELETION_CATALOG_VERSION },
      });

      return { status: 'enqueued' as const, requestId: request.id };
    });
  } catch (error) {
    // Covers the race where a conflicting request commits after the in-tx
    // HMAC/user_id checks and before insert — typically the user_id unique
    // index across two different email advisory locks.
    if (isUniqueActiveTargetError(error)) {
      const existing = await db.transaction(async tx => {
        const byEmail = await findActiveRequest(tx, email);
        if (byEmail) return byEmail;
        if (ticket) {
          const byTicket = await findActiveRequestByPylonTicket(tx, ticket);
          if (byTicket) return byTicket;
        }
        const users = await loadCurrentUsersByEmail(tx, email);
        if (users.length !== 1 || !users[0]) return null;
        return findActiveRequestByUserId(tx, users[0].id);
      });
      if (existing) {
        return { status: 'already_active', requestId: existing.id };
      }
    }
    throw error;
  }
}

export async function cancelPendingDeletionRequest(params: {
  requestId: string;
  actorKiloUserId: string;
}): Promise<{ cancelled: true } | { cancelled: false; code: 'not_pending' | 'not_found' }> {
  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, params.requestId))
      .for('update');

    if (!request) {
      return { cancelled: false as const, code: 'not_found' as const };
    }
    if (request.status !== UserDeletionRequestStatus.Pending) {
      return { cancelled: false as const, code: 'not_pending' as const };
    }
    if (request.target_email) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${deletionAdvisoryLockKey(normalizeDeletionEmail(request.target_email)).toString()}::int8)`
      );
    }

    await writeDeletionAudit(tx, {
      requestId: request.id,
      eventType: UserDeletionAuditEventType.Cancelled,
      actorKiloUserId: params.actorKiloUserId,
      targetEmailHmac: request.target_email_hmac,
      subjectKey: 'request',
    });

    await scrubControlPlanePii(tx, request.id, UserDeletionRequestStatus.Cancelled);
    return { cancelled: true as const };
  });
}

export async function scrubControlPlanePii(
  tx: DrizzleTransaction,
  requestId: string,
  terminalStatus:
    | typeof UserDeletionRequestStatus.Completed
    | typeof UserDeletionRequestStatus.Cancelled
): Promise<void> {
  const now = sql`now()`;
  await tx
    .update(user_deletion_requests)
    .set({
      status: terminalStatus,
      target_email: null,
      pylon_ticket_ref: null,
      user_id: null,
      completed_at: terminalStatus === UserDeletionRequestStatus.Completed ? now : null,
      cancelled_at: terminalStatus === UserDeletionRequestStatus.Cancelled ? now : null,
    })
    .where(eq(user_deletion_requests.id, requestId));

  await tx.execute(sql`
    UPDATE user_deletion_steps
    SET last_error_code = NULL,
      progress_json = '{}'::jsonb,
      manual_evidence_json = CASE
        WHEN manual_evidence_json IS NULL THEN NULL
        ELSE jsonb_build_object(
          'reason', '',
          'evidence', '',
          'actor_kilo_user_id', COALESCE(manual_evidence_json->>'actor_kilo_user_id', ''),
          'recorded_at', COALESCE(manual_evidence_json->>'recorded_at', '')
        )
      END
    WHERE request_id = ${requestId}
  `);

  await tx.execute(sql`
    UPDATE user_deletion_activity
    SET details_json = '{}'::jsonb
    WHERE request_id = ${requestId}
  `);
}

async function writeRefusalAudit(
  tx: DrizzleTransaction,
  params: { actor: EnqueueActor },
  hmac: string,
  code: RefusalCode
): Promise<void> {
  await writeDeletionAudit(tx, {
    requestId: null,
    eventType: UserDeletionAuditEventType.IntakeRefused,
    actorKiloUserId: params.actor.kiloUserId,
    targetEmailHmac: hmac,
    subjectKey: code,
    details: { code },
  });
}

async function findActiveRequest(tx: DrizzleTransaction, email: string) {
  const hmac = hmacDeletionEmail(email);
  const [row] = await tx
    .select({ id: user_deletion_requests.id })
    .from(user_deletion_requests)
    .where(
      and(
        eq(user_deletion_requests.target_email_hmac, hmac),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES)
      )
    )
    .limit(1);
  return row ?? null;
}

async function findActiveRequestByPylonTicket(tx: DrizzleTransaction, ticket: string) {
  const normalized = ticket.replace(/^#/, '');
  const [row] = await tx
    .select({ id: user_deletion_requests.id })
    .from(user_deletion_requests)
    .where(
      and(
        eq(sql`regexp_replace(${user_deletion_requests.pylon_ticket_ref}, '^#', '')`, normalized),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES)
      )
    )
    .limit(1);
  return row ?? null;
}

async function findActiveRequestByUserId(tx: DrizzleTransaction, userId: string) {
  const [row] = await tx
    .select({ id: user_deletion_requests.id })
    .from(user_deletion_requests)
    .where(
      and(
        eq(user_deletion_requests.user_id, userId),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES)
      )
    )
    .limit(1);
  return row ?? null;
}

async function loadCurrentUsersByEmail(tx: DrizzleTransaction, email: string): Promise<User[]> {
  const users = await tx
    .select()
    .from(kilocode_users)
    .where(eq(sql`lower(${kilocode_users.google_user_email})`, email));
  return users.filter(user => !isSoftDeletedBlockedReason(user.blocked_reason));
}

async function classifyCloudSubject(
  tx: DrizzleTransaction,
  params: {
    email: string;
    currentUser: User | null;
  }
): Promise<CloudSubjectClassification> {
  if (params.currentUser) {
    return {
      resolution: UserDeletionCloudSubjectResolution.CurrentUser,
      userId: params.currentUser.id,
      proofRef: null,
    };
  }

  const tombstoneHashes = [
    hashNormalizedEmailForDeletionTombstone(params.email),
    hashNormalizedEmailForDeletionTombstone(normalizeEmail(params.email)),
  ];
  const [tombstone] = await tx
    .select({ hash: deleted_user_email_tombstones.normalized_email_hash })
    .from(deleted_user_email_tombstones)
    .where(inArray(deleted_user_email_tombstones.normalized_email_hash, tombstoneHashes))
    .limit(1);

  const hmac = hmacDeletionEmail(params.email);
  const [completed] = await tx
    .select({ id: user_deletion_requests.id })
    .from(user_deletion_requests)
    .where(
      and(
        eq(user_deletion_requests.target_email_hmac, hmac),
        eq(user_deletion_requests.status, UserDeletionRequestStatus.Completed)
      )
    )
    .orderBy(user_deletion_requests.completed_at)
    .limit(1);

  if (completed) {
    return {
      resolution: UserDeletionCloudSubjectResolution.PriorQueueCleanup,
      userId: null,
      proofRef: completed.id,
    };
  }
  if (tombstone) {
    return {
      resolution: UserDeletionCloudSubjectResolution.LegacyIdentityUnresolved,
      userId: null,
      proofRef: 'deleted_user_email_tombstone',
    };
  }
  return {
    resolution: UserDeletionCloudSubjectResolution.AuthoritativeAbsence,
    userId: null,
    proofRef: null,
  };
}

function isUniqueActiveTargetError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const cause = 'cause' in error ? error.cause : error;
  if (!cause || typeof cause !== 'object') return false;
  const constraint = 'constraint' in cause ? cause.constraint : undefined;
  return (
    constraint === 'UQ_user_deletion_requests_active_email_hmac' ||
    constraint === 'UQ_user_deletion_requests_active_user_id' ||
    constraint === 'UQ_user_deletion_requests_active_pylon_ticket'
  );
}

export { UserDeletionStepKey };
