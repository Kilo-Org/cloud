import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  kilocode_users,
  organizations,
  support_access_grant_events,
  support_access_grants,
  type SupportAccessActionClass,
  type SupportAccessGrant,
  type SupportAccessGrantStatus,
  type SupportAccessGrantEventType,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  SUPPORT_READ_MAX_DURATION_SECONDS,
  SUPPORT_WRITE_MAX_DURATION_SECONDS,
  SUPPORT_WRITE_REQUEST_TTL_SECONDS,
} from '@kilocode/web-shared/lib/admin/support-access';
import { userIsSuperadmin } from '@/lib/admin/admin-permissions';
import { getPostgresErrorCode } from '@/lib/db-errors';

const OPEN_STATUSES: SupportAccessGrantStatus[] = ['pending', 'active'];

type GrantActorRow = typeof kilocode_users.$inferSelect;

const EMAIL_SHAPED = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

function forbidden(message: string, cause?: unknown): TRPCError {
  return new TRPCError({ code: 'FORBIDDEN', message, cause });
}

function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 2000) {
    throw badRequest('Reason must be between 10 and 2000 characters');
  }
  if (EMAIL_SHAPED.test(trimmed)) {
    throw badRequest('Reason must not contain email addresses');
  }
  return trimmed;
}

function assertTicketReference(ticketReference: string | null | undefined): string | null {
  if (ticketReference === undefined || ticketReference === null) return null;
  const trimmed = ticketReference.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 200) throw badRequest('Ticket reference must be at most 200 characters');
  return trimmed;
}

function clampDuration(
  actionClass: SupportAccessActionClass,
  requested: number | undefined
): number {
  const maximum =
    actionClass === 'support_read'
      ? SUPPORT_READ_MAX_DURATION_SECONDS
      : SUPPORT_WRITE_MAX_DURATION_SECONDS;
  const value = requested ?? maximum;
  if (!Number.isInteger(value) || value <= 0)
    throw badRequest('Duration must be a positive integer');
  return Math.min(value, maximum);
}

async function lockGrantScope(
  tx: DrizzleTransaction,
  actorKiloUserId: string,
  organizationId: string
): Promise<void> {
  const key = `support-access-grant:${actorKiloUserId}:${organizationId}`;
  await tx.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
  );
}

async function lockActors(
  tx: DrizzleTransaction,
  userIds: readonly string[]
): Promise<Map<string, GrantActorRow>> {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(kilocode_users)
    .where(inArray(kilocode_users.id, ids))
    .orderBy(asc(kilocode_users.id))
    .for('update');
  return new Map(rows.map(row => [row.id, row]));
}

function assertAdminActor(actor: GrantActorRow | undefined): GrantActorRow {
  if (!actor || actor.blocked_reason !== null || !actor.is_admin) {
    throw forbidden('Platform admin access required');
  }
  return actor;
}

async function assertLiveOrganization(
  tx: DrizzleTransaction,
  organizationId: string
): Promise<void> {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .for('share');
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
}

async function writeEvent(
  tx: DrizzleTransaction,
  grant: Pick<SupportAccessGrant, 'id' | 'organization_id' | 'action_class'>,
  eventType: SupportAccessGrantEventType,
  performedByKiloUserId: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  await tx.insert(support_access_grant_events).values({
    grant_id: grant.id,
    event_type: eventType,
    performed_by_kilo_user_id: performedByKiloUserId,
    organization_id: grant.organization_id,
    action_class: grant.action_class,
    metadata: metadata ?? null,
  });
}

/**
 * Advances grants whose clock has run out. Called under the actor/org advisory
 * lock so two requests cannot both claim the same stale row.
 */
async function expireStaleGrants(
  tx: DrizzleTransaction,
  scope: { actorKiloUserId?: string; organizationId?: string }
): Promise<void> {
  const conditions = [
    inArray(support_access_grants.status, OPEN_STATUSES),
    sql`(
      (${support_access_grants.status} = 'active' AND ${support_access_grants.expires_at} <= now())
      OR (${support_access_grants.status} = 'pending' AND ${support_access_grants.request_expires_at} <= now())
    )`,
  ];
  if (scope.actorKiloUserId) {
    conditions.push(eq(support_access_grants.actor_kilo_user_id, scope.actorKiloUserId));
  }
  if (scope.organizationId) {
    conditions.push(eq(support_access_grants.organization_id, scope.organizationId));
  }
  const expired = await tx
    .update(support_access_grants)
    .set({ status: 'expired', updated_at: sql`now()` })
    .where(and(...conditions))
    .returning({
      id: support_access_grants.id,
      organizationId: support_access_grants.organization_id,
      actionClass: support_access_grants.action_class,
    });
  for (const grant of expired) {
    await tx.insert(support_access_grant_events).values({
      grant_id: grant.id,
      event_type: 'expired',
      organization_id: grant.organizationId,
      action_class: grant.actionClass,
      metadata: { cause: 'time_elapsed' },
    });
  }
}

function issueWindow(actionClass: SupportAccessActionClass, durationSeconds: number) {
  const issuedAt = new Date();
  return {
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + durationSeconds * 1000),
  };
}

export type SupportGrantSummary = {
  id: string;
  actorKiloUserId: string;
  organizationId: string;
  actionClass: SupportAccessActionClass;
  grantKind: 'standard' | 'emergency';
  status: SupportAccessGrantStatus;
  reason: string;
  ticketReference: string | null;
  requestedAt: string;
  requestExpiresAt: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  approvedByKiloUserId: string | null;
  reviewRequired: boolean;
  reviewedAt: string | null;
};

export function toSupportGrantSummary(grant: SupportAccessGrant): SupportGrantSummary {
  return {
    id: grant.id,
    actorKiloUserId: grant.actor_kilo_user_id,
    organizationId: grant.organization_id,
    actionClass: grant.action_class,
    grantKind: grant.grant_kind,
    status: grant.status,
    reason: grant.reason,
    ticketReference: grant.ticket_reference,
    requestedAt: grant.requested_at,
    requestExpiresAt: grant.request_expires_at,
    issuedAt: grant.issued_at,
    expiresAt: grant.expires_at,
    approvedByKiloUserId: grant.approved_by_kilo_user_id,
    reviewRequired: grant.review_required,
    reviewedAt: grant.reviewed_at,
  };
}

export type SupportGrantPerson = { id: string; name: string | null; email: string | null };

export type SupportGrantListItem = SupportGrantSummary & {
  organizationName: string | null;
  actor: SupportGrantPerson;
  approvedBy: SupportGrantPerson | null;
};

export async function toSupportGrantListItems(
  grants: SupportAccessGrant[]
): Promise<SupportGrantListItem[]> {
  if (grants.length === 0) return [];
  const organizationIds = [...new Set(grants.map(grant => grant.organization_id))];
  const userIds = [
    ...new Set(
      grants.flatMap(grant =>
        grant.approved_by_kilo_user_id
          ? [grant.actor_kilo_user_id, grant.approved_by_kilo_user_id]
          : [grant.actor_kilo_user_id]
      )
    ),
  ];
  const [organizationRows, userRows] = await Promise.all([
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, organizationIds)),
    db
      .select({
        id: kilocode_users.id,
        name: kilocode_users.google_user_name,
        email: kilocode_users.google_user_email,
      })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, userIds)),
  ]);
  const organizationNames = new Map(organizationRows.map(row => [row.id, row.name]));
  const people = new Map(userRows.map(row => [row.id, row]));
  const person = (id: string): SupportGrantPerson =>
    people.get(id) ?? { id, name: null, email: null };

  return grants.map(grant => ({
    ...toSupportGrantSummary(grant),
    organizationName: organizationNames.get(grant.organization_id) ?? null,
    actor: person(grant.actor_kilo_user_id),
    approvedBy: grant.approved_by_kilo_user_id ? person(grant.approved_by_kilo_user_id) : null,
  }));
}

export async function requestSupportGrant(params: {
  actorKiloUserId: string;
  organizationId: string;
  actionClass: SupportAccessActionClass;
  reason: string;
  ticketReference?: string | null;
  durationSeconds?: number;
}): Promise<SupportAccessGrant> {
  const reason = assertReason(params.reason);
  const ticketReference = assertTicketReference(params.ticketReference);
  const durationSeconds = clampDuration(params.actionClass, params.durationSeconds);

  try {
    return await db.transaction(async tx => {
      await lockGrantScope(tx, params.actorKiloUserId, params.organizationId);
      const actors = await lockActors(tx, [params.actorKiloUserId]);
      const actor = assertAdminActor(actors.get(params.actorKiloUserId));
      await expireStaleGrants(tx, {
        actorKiloUserId: params.actorKiloUserId,
        organizationId: params.organizationId,
      });
      await assertLiveOrganization(tx, params.organizationId);

      const now = new Date();
      const isRead = params.actionClass === 'support_read';
      const issue = isRead ? issueWindow(params.actionClass, durationSeconds) : null;
      const [grant] = await tx
        .insert(support_access_grants)
        .values({
          actor_kilo_user_id: actor.id,
          organization_id: params.organizationId,
          action_class: params.actionClass,
          grant_kind: 'standard',
          status: isRead ? 'active' : 'pending',
          reason,
          ticket_reference: ticketReference,
          requested_duration_seconds: durationSeconds,
          requested_at: now.toISOString(),
          request_expires_at: isRead
            ? null
            : new Date(now.getTime() + SUPPORT_WRITE_REQUEST_TTL_SECONDS * 1000).toISOString(),
          issued_at: issue?.issuedAt.toISOString() ?? null,
          expires_at: issue?.expiresAt.toISOString() ?? null,
        })
        .returning();

      await writeEvent(tx, grant, 'requested', actor.id, {
        actionClass: params.actionClass,
        durationSeconds,
      });
      if (isRead) {
        await writeEvent(tx, grant, 'issued', actor.id, { automatic: true });
      }
      return grant;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'An open support access grant already exists for this organization and class',
      });
    }
    throw error;
  }
}

export async function approveSupportGrant(params: {
  approverKiloUserId: string;
  grantId: string;
  durationSeconds?: number;
}): Promise<SupportAccessGrant> {
  return db.transaction(async tx => {
    const [unlocked] = await tx
      .select()
      .from(support_access_grants)
      .where(eq(support_access_grants.id, params.grantId))
      .limit(1);
    if (!unlocked) throw new TRPCError({ code: 'NOT_FOUND', message: 'Grant not found' });
    if (unlocked.actor_kilo_user_id === params.approverKiloUserId) {
      throw badRequest('A request cannot be approved by its requester');
    }

    // Advisory lock before any row lock: request() takes advisory first, and a
    // reverse order here would deadlock.
    await lockGrantScope(tx, unlocked.actor_kilo_user_id, unlocked.organization_id);
    const actors = await lockActors(tx, [unlocked.actor_kilo_user_id, params.approverKiloUserId]);
    await expireStaleGrants(tx, {
      actorKiloUserId: unlocked.actor_kilo_user_id,
      organizationId: unlocked.organization_id,
    });
    const [pending] = await tx
      .select()
      .from(support_access_grants)
      .where(eq(support_access_grants.id, params.grantId))
      .for('update');
    if (!pending) throw new TRPCError({ code: 'NOT_FOUND', message: 'Grant not found' });
    if (pending.status !== 'pending') {
      throw new TRPCError({ code: 'CONFLICT', message: 'Grant is not pending' });
    }
    if (pending.action_class !== 'support_write') {
      throw badRequest('Only write grants require approval');
    }
    assertAdminActor(actors.get(pending.actor_kilo_user_id));
    const approver = actors.get(params.approverKiloUserId);
    if (!approver || approver.blocked_reason !== null || !approver.is_admin) {
      throw forbidden('Platform admin access required');
    }
    await assertLiveOrganization(tx, pending.organization_id);

    const durationSeconds = clampDuration(
      'support_write',
      params.durationSeconds ?? pending.requested_duration_seconds
    );
    const issue = issueWindow('support_write', durationSeconds);
    const [grant] = await tx
      .update(support_access_grants)
      .set({
        status: 'active',
        approved_by_kilo_user_id: params.approverKiloUserId,
        decided_at: issue.issuedAt.toISOString(),
        issued_at: issue.issuedAt.toISOString(),
        expires_at: issue.expiresAt.toISOString(),
        request_expires_at: null,
      })
      .where(
        and(eq(support_access_grants.id, unlocked.id), eq(support_access_grants.status, 'pending'))
      )
      .returning();
    if (!grant) throw new TRPCError({ code: 'CONFLICT', message: 'Grant is no longer pending' });

    await writeEvent(tx, grant, 'approved', params.approverKiloUserId);
    await writeEvent(tx, grant, 'issued', params.approverKiloUserId, { durationSeconds });
    return grant;
  });
}

export async function denySupportGrant(params: {
  approverKiloUserId: string;
  grantId: string;
}): Promise<SupportAccessGrant> {
  return db.transaction(async tx => {
    const [unlocked] = await tx
      .select()
      .from(support_access_grants)
      .where(eq(support_access_grants.id, params.grantId))
      .limit(1);
    if (!unlocked) throw new TRPCError({ code: 'NOT_FOUND', message: 'Grant not found' });
    if (unlocked.actor_kilo_user_id === params.approverKiloUserId) {
      throw badRequest('A request cannot be denied by its requester');
    }
    await lockGrantScope(tx, unlocked.actor_kilo_user_id, unlocked.organization_id);
    const actors = await lockActors(tx, [params.approverKiloUserId]);
    const approver = actors.get(params.approverKiloUserId);
    if (!approver || approver.blocked_reason !== null || !approver.is_admin) {
      throw forbidden('Platform admin access required');
    }
    const [grant] = await tx
      .update(support_access_grants)
      .set({
        status: 'denied',
        decided_at: new Date().toISOString(),
        request_expires_at: null,
      })
      .where(
        and(eq(support_access_grants.id, unlocked.id), eq(support_access_grants.status, 'pending'))
      )
      .returning();
    if (!grant) throw new TRPCError({ code: 'CONFLICT', message: 'Grant is no longer pending' });
    await writeEvent(tx, grant, 'denied', params.approverKiloUserId);
    return grant;
  });
}

export async function cancelSupportGrant(params: {
  actorKiloUserId: string;
  grantId: string;
}): Promise<SupportAccessGrant> {
  return db.transaction(async tx => {
    const [unlocked] = await tx
      .select()
      .from(support_access_grants)
      .where(eq(support_access_grants.id, params.grantId))
      .limit(1);
    if (!unlocked) throw new TRPCError({ code: 'NOT_FOUND', message: 'Grant not found' });
    if (unlocked.actor_kilo_user_id !== params.actorKiloUserId) {
      throw forbidden('Only the requester can cancel a support access request');
    }
    await lockGrantScope(tx, unlocked.actor_kilo_user_id, unlocked.organization_id);
    await lockActors(tx, [params.actorKiloUserId]);
    const [grant] = await tx
      .update(support_access_grants)
      .set({
        status: 'cancelled',
        decided_at: new Date().toISOString(),
        request_expires_at: null,
      })
      .where(
        and(eq(support_access_grants.id, unlocked.id), eq(support_access_grants.status, 'pending'))
      )
      .returning();
    if (!grant) throw new TRPCError({ code: 'CONFLICT', message: 'Grant is no longer pending' });
    await writeEvent(tx, grant, 'cancelled', params.actorKiloUserId);
    return grant;
  });
}

export async function revokeSupportGrant(params: {
  actorKiloUserId: string;
  grantId: string;
  reason: string;
}): Promise<SupportAccessGrant> {
  const reason = assertReason(params.reason);
  return db.transaction(async tx => {
    const [unlocked] = await tx
      .select()
      .from(support_access_grants)
      .where(eq(support_access_grants.id, params.grantId))
      .limit(1);
    if (!unlocked) throw new TRPCError({ code: 'NOT_FOUND', message: 'Grant not found' });
    await lockGrantScope(tx, unlocked.actor_kilo_user_id, unlocked.organization_id);
    const actors = await lockActors(tx, [params.actorKiloUserId]);
    const [existing] = await tx
      .select()
      .from(support_access_grants)
      .where(eq(support_access_grants.id, params.grantId))
      .for('update');
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Grant not found' });
    const actor = actors.get(params.actorKiloUserId);
    if (!actor || actor.blocked_reason !== null) {
      throw forbidden('Support access revocation permission required');
    }
    const canRevoke =
      actor.id === existing.actor_kilo_user_id ||
      actor.id === existing.approved_by_kilo_user_id ||
      userIsSuperadmin(actor);
    if (!canRevoke) throw forbidden('Support access revocation permission required');

    const [grant] = await tx
      .update(support_access_grants)
      .set({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by_kilo_user_id: actor.id,
        revoke_reason: reason,
        request_expires_at: null,
      })
      .where(
        and(
          eq(support_access_grants.id, existing.id),
          inArray(support_access_grants.status, OPEN_STATUSES)
        )
      )
      .returning();
    if (!grant) throw new TRPCError({ code: 'CONFLICT', message: 'Grant is already closed' });
    await writeEvent(tx, grant, 'revoked', actor.id);
    return grant;
  });
}

export async function emergencyIssueSupportGrant(params: {
  superadminKiloUserId: string;
  organizationId: string;
  reason: string;
  ticketReference?: string | null;
  durationSeconds?: number;
}): Promise<SupportAccessGrant> {
  const reason = assertReason(params.reason);
  const ticketReference = assertTicketReference(params.ticketReference);
  const durationSeconds = clampDuration('support_write', params.durationSeconds);

  try {
    return await db.transaction(async tx => {
      await lockGrantScope(tx, params.superadminKiloUserId, params.organizationId);
      const actors = await lockActors(tx, [params.superadminKiloUserId]);
      const actor = actors.get(params.superadminKiloUserId);
      await expireStaleGrants(tx, {
        actorKiloUserId: params.superadminKiloUserId,
        organizationId: params.organizationId,
      });
      if (!actor || actor.blocked_reason !== null || !userIsSuperadmin(actor)) {
        throw forbidden('Superadmin access required');
      }
      await assertLiveOrganization(tx, params.organizationId);
      const issue = issueWindow('support_write', durationSeconds);
      const [grant] = await tx
        .insert(support_access_grants)
        .values({
          actor_kilo_user_id: actor.id,
          organization_id: params.organizationId,
          action_class: 'support_write',
          grant_kind: 'emergency',
          status: 'active',
          reason,
          ticket_reference: ticketReference,
          requested_duration_seconds: durationSeconds,
          requested_at: issue.issuedAt.toISOString(),
          decided_at: issue.issuedAt.toISOString(),
          issued_at: issue.issuedAt.toISOString(),
          expires_at: issue.expiresAt.toISOString(),
          review_required: true,
        })
        .returning();
      await writeEvent(tx, grant, 'emergency_issued', actor.id, { durationSeconds });
      return grant;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'An open support access grant already exists for this organization and class',
      });
    }
    throw error;
  }
}

export async function reviewSupportGrant(params: {
  reviewerKiloUserId: string;
  grantId: string;
}): Promise<SupportAccessGrant> {
  return db.transaction(async tx => {
    const [unlocked] = await tx
      .select()
      .from(support_access_grants)
      .where(eq(support_access_grants.id, params.grantId))
      .limit(1);
    if (!unlocked) throw new TRPCError({ code: 'NOT_FOUND', message: 'Grant not found' });
    if (unlocked.actor_kilo_user_id === params.reviewerKiloUserId) {
      throw badRequest('A grant cannot be reviewed by its requester');
    }
    await lockGrantScope(tx, unlocked.actor_kilo_user_id, unlocked.organization_id);
    const actors = await lockActors(tx, [params.reviewerKiloUserId]);
    const [existing] = await tx
      .select()
      .from(support_access_grants)
      .where(eq(support_access_grants.id, params.grantId))
      .for('update');
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Grant not found' });
    const reviewer = actors.get(params.reviewerKiloUserId);
    if (!reviewer || reviewer.blocked_reason !== null || !userIsSuperadmin(reviewer)) {
      throw forbidden('Superadmin access required');
    }
    if (!existing.review_required || existing.reviewed_at !== null) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Grant does not need review' });
    }
    const [grant] = await tx
      .update(support_access_grants)
      .set({
        reviewed_at: new Date().toISOString(),
        reviewed_by_kilo_user_id: reviewer.id,
      })
      .where(eq(support_access_grants.id, existing.id))
      .returning();
    await writeEvent(tx, grant, 'reviewed', reviewer.id);
    return grant;
  });
}

export async function listMySupportGrants(actorKiloUserId: string): Promise<SupportAccessGrant[]> {
  return db
    .select()
    .from(support_access_grants)
    .where(
      and(
        eq(support_access_grants.actor_kilo_user_id, actorKiloUserId),
        inArray(support_access_grants.status, OPEN_STATUSES)
      )
    )
    .orderBy(desc(support_access_grants.requested_at));
}

export async function listPendingSupportGrants(): Promise<SupportAccessGrant[]> {
  return db
    .select()
    .from(support_access_grants)
    .where(eq(support_access_grants.status, 'pending'))
    .orderBy(asc(support_access_grants.requested_at));
}

export async function listActiveSupportGrants(): Promise<SupportAccessGrant[]> {
  return db
    .select()
    .from(support_access_grants)
    .where(eq(support_access_grants.status, 'active'))
    .orderBy(asc(support_access_grants.expires_at));
}

export async function listUnreviewedEmergencyGrants(): Promise<SupportAccessGrant[]> {
  return db
    .select()
    .from(support_access_grants)
    .where(
      and(
        eq(support_access_grants.review_required, true),
        isNull(support_access_grants.reviewed_at)
      )
    )
    .orderBy(desc(support_access_grants.issued_at));
}

export async function getActiveSupportGrantsForOrganization(
  organizationId: string
): Promise<SupportAccessGrant[]> {
  return db
    .select()
    .from(support_access_grants)
    .where(
      and(
        eq(support_access_grants.organization_id, organizationId),
        eq(support_access_grants.status, 'active')
      )
    )
    .orderBy(asc(support_access_grants.expires_at));
}

function isUniqueViolation(error: unknown): boolean {
  return getPostgresErrorCode(error) === '23505';
}
