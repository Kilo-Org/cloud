import {
  updateUserRoleInOrganization,
  removeUserFromOrganization,
  addUserToOrganization,
  getOrganizationById,
  getOrganizationMembers,
  inviteUserToOrganization,
  getAcceptInviteUrl,
} from '@/lib/organizations/organizations';
import { updateOrganizationUserLimit } from '@/lib/organizations/organization-usage';
import {
  organization_memberships,
  organization_invitations,
  kilocode_users,
  organizations,
  operation_ledgers,
  type OperationLedgerRow,
} from '@kilocode/db/schema';
import { db, sql } from '@/lib/drizzle';
import { createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import {
  ensureOrganizationAccess,
  OrganizationIdInputSchema,
  organizationAdminMutationProcedure,
  organizationBillingMutationProcedure,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { ORGANIZATION_WRITE_SETTLED_EVENT } from '@kilocode/app-shared/analytics';
import { sendOrganizationInviteEmail } from '@/lib/email';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { findUserById } from '@/lib/user';
import { successResult, type SuccessResult } from '@/lib/maybe-result';
import { destroyOrgInstancesForUser } from '@/lib/kiloclaw/instance-registry';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { revokeGatewayStateForOrganizationMember } from '@/lib/mcp-gateway/lifecycle-service';
import {
  OrganizationRoleSchema,
  PublicOrganizationMembersSchema,
} from '@/lib/organizations/organization-types';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import {
  admitOperation,
  settleOperation,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';

const MAX_DAILY_LIMIT_USD = 2000;

const operationKeySchema = z.string().min(1).max(128).optional();

const UpdateMemberSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  role: OrganizationRoleSchema.optional(),
  dailyUsageLimitUsd: z.number().min(0).max(MAX_DAILY_LIMIT_USD).nullable().optional(),
  /** Optional client-generated per-intent key for the role-change ledger (P1-A-08e). */
  operationKey: operationKeySchema,
});

const RemoveMemberSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  /** Optional client-generated per-intent key for the member-removal ledger (P1-A-08e). */
  operationKey: operationKeySchema,
});

const InviteMemberSchema = OrganizationIdInputSchema.extend({
  email: z.email('Invalid email address'),
  role: OrganizationRoleSchema,
});

const DeleteInviteSchema = OrganizationIdInputSchema.extend({
  inviteId: z.string(),
});

const SetChildMembershipsSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  childOrganizationIds: z.array(z.uuid()),
});

const OWNER_AUTHORITY_MESSAGE = 'Only an organization owner can manage owners';

/**
 * Reserves owner authority for owners. Admins match owners everywhere else, but
 * may not grant the owner role nor act on an existing owner's membership. Both
 * halves are required: allowing only one would let an admin strip every owner
 * while being unable to appoint a replacement, leaving the org with no owner.
 *
 * Kilo staff bypass this because `ensureOrganizationAccess` resolves them to
 * `owner`.
 */
function assertOwnerAuthority(
  actorRole: OrganizationRole,
  target: { currentRole?: OrganizationRole | null; nextRole?: OrganizationRole | null }
): void {
  if (actorRole === 'owner') {
    return;
  }
  if (target.currentRole === 'owner' || target.nextRole === 'owner') {
    throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_AUTHORITY_MESSAGE });
  }
}

async function getDirectOrganizationRole(
  organizationId: string,
  userId: string
): Promise<OrganizationRole | null> {
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .limit(1);

  return membership?.role ?? null;
}

// ---------------------------------------------------------------------------
// Organization operation ledger (P1-A-08e)
// ---------------------------------------------------------------------------
//
// The role-change (`update` with `role`) and member-removal (`remove`)
// mutations accept an optional `operationKey`. When present, the mutation
// admits a `reconcile-first` ledger row BEFORE the mutable membership lookup,
// so a same-key retry replays, repairs, or conflicts instead of being rejected
// by a precondition the first attempt already satisfied. On success the audit
// log, the terminal settle and the `organization_write_settled` outbox event
// share ONE transaction. Every definitive rejection (failed helper, absent
// member, bot refusal, authorization denial) settles the row `failed` so the
// same-key retry replays the rejection; an operational error is rethrown
// untouched and leaves the row retryable. A takeover reads the membership back
// FIRST: re-running the helper over already-applied state would fail with
// NOT_FOUND. The un-keyed paths and the `dailyUsageLimitUsd` path are unchanged.

const ORG_LEDGER_DOMAIN = 'organization' as const;
/** The in-flight window: while an `admitted` row holds a live lease, same-key
 *  retries receive CONFLICT `operation_in_progress` instead of re-running. */
const ORG_LEDGER_LEASE_SECONDS = 120;

type OrgLedgerIntent = 'member_role_change' | 'member_remove';

const ORG_OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
const ORG_REPLAY_FAILED_MESSAGE = 'This action did not complete. Please try again.';
const ORG_OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';
/** Canonical result and response value of a settled role change; they must match. */
const ORG_ROLE_CHANGE_UPDATED = 'role and limit';
// Member-removal cleanup marker in a settled row's canonical result: the settle
// records `pending`, and only a successful post-removal gateway revocation
// flips it to `complete`, so a same-key replay can tell whether the required
// cleanup still needs retrying.
const ORG_MEMBER_REMOVAL_CLEANUP_PENDING = 'pending';
const ORG_MEMBER_REMOVAL_CLEANUP_COMPLETE = 'complete';
// A provider-confirmed outcome whose ledger settle failed: the membership
// helper DID commit, but the row was not settled. Never surface a success
// receipt for an un-recorded row — a same-key retry repairs by read-back.
const ORG_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';

type OrgActor = {
  id: string;
  google_user_email: string | null;
  google_user_name: string | null;
  is_admin: boolean;
};

/** Result of a keyed organization write; `replayed` marks a deduped retry. */
type OrgWriteResult = SuccessResult<{ updated: string; replayed?: boolean }>;

/** `organization_write_settled` outbox payload (DEC-05): no free text, no resource keys. */
function orgSettledOutboxEvent(params: {
  user: OrgActor;
  intent: OrgLedgerIntent;
  outcome: 'completed' | 'failed';
}): OutboxEventInput {
  return {
    eventName: ORGANIZATION_WRITE_SETTLED_EVENT,
    // Identity channel (the user's email), not an event property.
    distinctId: params.user.google_user_email || params.user.id,
    properties: {
      source: 'web',
      surface: 'organization',
      phase: 'terminal',
      intent: params.intent,
      outcome: params.outcome,
    },
  };
}

function orgMemberRoleResourceKey(organizationId: string, memberId: string, role: string): string {
  return `organization:${organizationId}:member:${memberId}:role:${role}`;
}

function orgMemberRemoveResourceKey(organizationId: string, memberId: string): string {
  return `organization:${organizationId}:member:${memberId}`;
}

/**
 * The target membership's role, or undefined when the user is not a member.
 * `UQ_organization_memberships_org_user` makes the row unique per
 * (organization, member).
 */
async function readOrgMemberRole(
  organizationId: string,
  memberId: string
): Promise<{ role: OrganizationRole } | undefined> {
  const [member] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, memberId)
      )
    );
  return member;
}

/** The target membership plus the service-account flag used by the removal guard. */
async function readOrgMemberWithBotFlag(
  organizationId: string,
  memberId: string
): Promise<{ role: OrganizationRole; isBot: boolean } | undefined> {
  const [member] = await db
    .select({
      role: organization_memberships.role,
      isBot: kilocode_users.is_bot,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, memberId)
      )
    );
  return member;
}

/**
 * Best-effort FAILED settle: the caller is already returning a typed rejection,
 * so a ledger write failure here must never mask the helper outcome.
 */
async function settleOrgWriteFailed(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  intent: OrgLedgerIntent;
  outcomeCode: string;
}): Promise<void> {
  try {
    await settleOperation(db, {
      rowId: args.row.id,
      status: 'failed',
      outcomeCode: args.outcomeCode,
      outboxEvent: orgSettledOutboxEvent({
        user: args.user,
        intent: args.intent,
        outcome: 'failed',
      }),
    });
  } catch (error) {
    console.error(
      `Failed to write organization operation ledger row: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Re-checks organization access and owner authority on a keyed path. Only a
 * definitive authorization rejection (`UNAUTHORIZED` from
 * `ensureOrganizationAccess`, `FORBIDDEN` from `assertOwnerAuthority`) settles
 * the row `failed`, so a same-key retry replays it. An operational database
 * error is rethrown untouched and leaves the row retryable.
 */
async function assertKeyedOrgAuthority(args: {
  row: OperationLedgerRow;
  ctx: TRPCContext;
  user: OrgActor;
  organizationId: string;
  intent: OrgLedgerIntent;
  target: { currentRole?: OrganizationRole | null; nextRole?: OrganizationRole | null };
}): Promise<void> {
  try {
    const actorRole = await ensureOrganizationAccess(
      args.ctx,
      args.organizationId,
      ORGANIZATION_MANAGE_ROLES
    );
    assertOwnerAuthority(actorRole, args.target);
  } catch (error) {
    if (
      error instanceof TRPCError &&
      (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN')
    ) {
      await settleOrgWriteFailed({
        row: args.row,
        user: args.user,
        intent: args.intent,
        outcomeCode: 'authorization_failed',
      });
    }
    throw error;
  }
}

/**
 * Durably records a provider-confirmed org outcome: the success audit log, the
 * terminal settle and the success outbox event share ONE transaction. A settle
 * failure must never yield a success receipt for an un-recorded row.
 */
async function auditAndSettleOrgCompleted(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  intent: OrgLedgerIntent;
  action: 'organization.member.change_role' | 'organization.member.remove';
  message: string;
  canonicalResult: Record<string, unknown>;
}): Promise<void> {
  await db.transaction(async tx => {
    await createAuditLog({
      action: args.action,
      actor_email: args.user.google_user_email,
      actor_id: args.user.id,
      actor_name: args.user.google_user_name,
      message: args.message,
      organization_id: args.organizationId,
      tx,
    });
    try {
      await settleOperation(tx, {
        rowId: args.row.id,
        status: 'completed',
        outcomeCode: 'ok',
        canonicalResult: args.canonicalResult,
        outboxEvent: orgSettledOutboxEvent({
          user: args.user,
          intent: args.intent,
          outcome: 'completed',
        }),
      });
    } catch (error) {
      console.error(
        `Failed to settle completed organization operation ledger row: ${error instanceof Error ? error.message : String(error)}`
      );
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: ORG_LEDGER_SETTLE_FAILED_MESSAGE,
        cause: error,
      });
    }
  });
}

/**
 * Audit + settle + outbox for a completed role change. The `reconciled` variant
 * is the takeover repair: it read the role back and never observed the actor's
 * original write, so the audit message must not claim a `from` role it saw.
 */
type OrgRoleChangeAuditArgs = {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  memberId: string;
  toRole: OrganizationRole;
} & ({ reconciled: true } | { reconciled?: false; fromRole: string });

async function auditAndSettleOrgRoleChange(args: OrgRoleChangeAuditArgs): Promise<void> {
  const updatedUser = await findUserById(args.memberId);
  const email = updatedUser?.google_user_email || 'unknown';
  await auditAndSettleOrgCompleted({
    row: args.row,
    user: args.user,
    organizationId: args.organizationId,
    intent: 'member_role_change',
    action: 'organization.member.change_role',
    message: args.reconciled
      ? `Reconciled role for user ${email} to ${args.toRole}; the original role change was not confirmed`
      : `Changed role for user ${email} from ${args.fromRole} to ${args.toRole}`,
    canonicalResult: { updated: ORG_ROLE_CHANGE_UPDATED },
  });
}

/** Replays a terminal row: only `completed`/`no_op` may replay a canonical result. */
function replaySettledOrgRow(row: OperationLedgerRow): OrgWriteResult {
  if (row.status !== 'completed' && row.status !== 'no_op') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: ORG_REPLAY_FAILED_MESSAGE });
  }
  return { success: true, ...(row.canonical_result ?? {}), replayed: true } as OrgWriteResult;
}

/**
 * Replays a settled `member_remove` row. The removal is never re-run, but the
 * post-removal cleanup IS retried when it was not recorded complete: a first
 * attempt whose cleanup failed settled with `cleanup: 'pending'`, and rows
 * settled before this marker predate it, so anything but `'complete'` counts as
 * incomplete. The cleanup is idempotent. A cleanup retry that fails again keeps
 * the row retryable and surfaces the failure instead of a false success.
 */
async function replaySettledOrgMemberRemoval(args: {
  row: OperationLedgerRow;
  organizationId: string;
  memberId: string;
}): Promise<OrgWriteResult> {
  const { row, organizationId, memberId } = args;
  if (row.status !== 'completed' && row.status !== 'no_op') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: ORG_REPLAY_FAILED_MESSAGE });
  }
  const canonicalResult = row.canonical_result as { updated?: unknown; cleanup?: unknown } | null;
  if (canonicalResult?.cleanup !== ORG_MEMBER_REMOVAL_CLEANUP_COMPLETE) {
    await runOrgMemberRemovalCleanup(row.id, organizationId, memberId);
  }
  return {
    success: true,
    updated: typeof canonicalResult?.updated === 'string' ? canonicalResult.updated : memberId,
    replayed: true,
  };
}

/**
 * Runs the role-change helper under an already-admitted row. A failed helper
 * result settles the row `failed` without a success audit or success outbox.
 */
async function executeOrgRoleChange(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  memberId: string;
  role: OrganizationRole;
  dailyUsageLimitUsd?: number | null;
  currentRole: string;
}): Promise<OrgWriteResult> {
  const { row, user, organizationId, memberId, role } = args;

  const result = await updateUserRoleInOrganization(organizationId, memberId, role);
  if (!result.success) {
    await settleOrgWriteFailed({
      row,
      user,
      intent: 'member_role_change',
      outcomeCode: 'role_change_failed',
    });
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Failed to update user role',
    });
  }

  if (args.dailyUsageLimitUsd !== undefined) {
    await updateOrganizationUserLimit(organizationId, memberId, args.dailyUsageLimitUsd);
  }

  await auditAndSettleOrgRoleChange({
    row,
    user,
    organizationId,
    memberId,
    fromRole: args.currentRole,
    toRole: role,
  });

  return successResult({ updated: ORG_ROLE_CHANGE_UPDATED });
}

/** First (`admitted`) execution of a keyed role change. */
async function firstOrgRoleChange(args: {
  row: OperationLedgerRow;
  ctx: TRPCContext;
  user: OrgActor;
  organizationId: string;
  memberId: string;
  role: OrganizationRole;
  dailyUsageLimitUsd?: number | null;
}): Promise<OrgWriteResult> {
  const { row, user, organizationId, memberId, role } = args;
  const targetMember = await readOrgMemberRole(organizationId, memberId);

  // A first-time role change of an absent member settles the row `failed` so a
  // later same-key retry replays the failure instead of taking over past the
  // membership check.
  if (!targetMember) {
    await settleOrgWriteFailed({
      row,
      user,
      intent: 'member_role_change',
      outcomeCode: 'member_absent',
    });
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'User is not a member of this organization',
    });
  }

  // Only an owner may grant the owner role or act on an existing owner's
  // membership. Runs after the membership read so the admission stays before
  // the mutable lookup.
  await assertKeyedOrgAuthority({
    row,
    ctx: args.ctx,
    user,
    organizationId,
    intent: 'member_role_change',
    target: { currentRole: targetMember.role, nextRole: role },
  });

  return executeOrgRoleChange({
    row,
    user,
    organizationId,
    memberId,
    role,
    dailyUsageLimitUsd: args.dailyUsageLimitUsd,
    currentRole: targetMember.role,
  });
}

/**
 * Read-back-first takeover repair for a role change. The target role already
 * applied means the first attempt committed without settling. An absent
 * membership means the same thing: the keyed path settles `failed` when the
 * member is absent on first execution, so the original success committed and
 * the member was REMOVED later. Both settle completed and replay. Otherwise the
 * helper re-runs under the same row.
 */
async function repairOrgRoleChange(args: {
  row: OperationLedgerRow;
  ctx: TRPCContext;
  user: OrgActor;
  organizationId: string;
  memberId: string;
  role: OrganizationRole;
  dailyUsageLimitUsd?: number | null;
}): Promise<OrgWriteResult> {
  const { row, user, organizationId, memberId, role } = args;
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, memberId)
      )
    )
    .limit(1);

  if (!membership || membership.role === role) {
    await auditAndSettleOrgRoleChange({
      row,
      user,
      organizationId,
      memberId,
      toRole: role,
      reconciled: true,
    });
    return successResult({ updated: ORG_ROLE_CHANGE_UPDATED, replayed: true });
  }

  // Not applied yet: re-run the helper under the same row. The first attempt
  // may have crashed right after admission, so re-check owner authority — an
  // admin must never grant the owner role nor act on an owner's membership,
  // even through the takeover path.
  await assertKeyedOrgAuthority({
    row,
    ctx: args.ctx,
    user,
    organizationId,
    intent: 'member_role_change',
    target: { currentRole: membership.role, nextRole: role },
  });
  return executeOrgRoleChange({
    row,
    user,
    organizationId,
    memberId,
    role,
    dailyUsageLimitUsd: args.dailyUsageLimitUsd,
    currentRole: membership.role,
  });
}

/** KiloClaw instance cleanup after a member removal (existing behavior, extracted). */
async function cleanupRemovedMemberInstances(
  memberId: string,
  organizationId: string
): Promise<void> {
  // Runs after the membership deletion transaction commits.
  // Fire-and-forget worker calls — Postgres rows are already soft-deleted,
  // so even if worker calls fail the instance is "dead" from the platform
  // perspective and reconciliation will clean up.
  try {
    const destroyedInstances = await destroyOrgInstancesForUser(memberId, organizationId);
    if (destroyedInstances.length > 0) {
      const client = new KiloClawInternalClient();
      const results = await Promise.allSettled(
        destroyedInstances.map(({ instanceId }) =>
          client.destroy(memberId, instanceId, { reason: 'org_member_cleanup' })
        )
      );
      for (const [i, result] of results.entries()) {
        if (result.status === 'rejected') {
          console.error(
            `[kiloclaw-org] Failed to destroy worker instance ${destroyedInstances[i].instanceId} for removed member ${memberId}:`,
            result.reason
          );
        }
      }
      console.log(
        `[kiloclaw-org] Destroyed ${destroyedInstances.length} instance(s) for removed member ${memberId} in org ${organizationId}`
      );
    }
  } catch (err) {
    console.error(
      `[kiloclaw-org] Failed to clean up KiloClaw instances for removed member ${memberId}:`,
      err
    );
  }
}

/**
 * Required post-removal cleanup, then the `complete` marker. A marker write
 * failure never fails the removal response: it only means a later same-key
 * replay re-runs the idempotent cleanup and tries the marker again.
 */
async function runOrgMemberRemovalCleanup(
  rowId: string,
  organizationId: string,
  memberId: string
): Promise<void> {
  await revokeGatewayStateForOrganizationMember(db, organizationId, memberId);
  await cleanupRemovedMemberInstances(memberId, organizationId);
  try {
    await db
      .update(operation_ledgers)
      .set({
        canonical_result: {
          updated: memberId,
          cleanup: ORG_MEMBER_REMOVAL_CLEANUP_COMPLETE,
        },
      })
      .where(eq(operation_ledgers.id, rowId));
  } catch (error) {
    console.error(
      `Failed to mark organization member removal cleanup complete for ledger row ${rowId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/** Transactional success audit + settle + outbox, then the post-removal cleanup. */
async function completeOrgMemberRemoval(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  memberId: string;
}): Promise<OrgWriteResult> {
  const removedUser = await findUserById(args.memberId);

  await auditAndSettleOrgCompleted({
    row: args.row,
    user: args.user,
    organizationId: args.organizationId,
    intent: 'member_remove',
    action: 'organization.member.remove',
    message: `Removed user ${removedUser?.google_user_email || 'unknown'}`,
    canonicalResult: {
      updated: args.memberId,
      cleanup: ORG_MEMBER_REMOVAL_CLEANUP_PENDING,
    },
  });

  // The gateway revocation runs after the terminal settle. If it fails, the
  // settled row keeps `cleanup: 'pending'`, so a same-key replay retries the
  // cleanup (see `replaySettledOrgMemberRemoval`) instead of replaying a
  // success that never revoked.
  await runOrgMemberRemovalCleanup(args.row.id, args.organizationId, args.memberId);

  return successResult({ updated: args.memberId });
}

/**
 * Runs the removal helper under an already-admitted row. A `rowCount` of zero
 * means the member was already gone (never satisfied under the `admitted`
 * path): settle failed and surface the existing NOT_FOUND rejection.
 */
async function executeOrgMemberRemove(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  memberId: string;
}): Promise<OrgWriteResult> {
  const result = await removeUserFromOrganization(args.organizationId, args.memberId, args.user.id);
  if (result.rowCount === 0) {
    await settleOrgWriteFailed({
      row: args.row,
      user: args.user,
      intent: 'member_remove',
      outcomeCode: 'member_absent',
    });
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Failed to remove user from organization',
    });
  }
  return completeOrgMemberRemoval(args);
}

/** First (`admitted`) execution of a keyed member removal. */
async function firstOrgMemberRemove(args: {
  row: OperationLedgerRow;
  ctx: TRPCContext;
  user: OrgActor;
  organizationId: string;
  memberId: string;
}): Promise<OrgWriteResult> {
  const { row, user, organizationId, memberId } = args;
  const targetMember = await readOrgMemberWithBotFlag(organizationId, memberId);

  // A first-time removal of a member that is already gone settles the row
  // `failed` so a later same-key retry replays the failure instead of taking
  // over into the removal helper.
  if (!targetMember) {
    await settleOrgWriteFailed({
      row,
      user,
      intent: 'member_remove',
      outcomeCode: 'member_absent',
    });
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'User is not a member of this organization',
    });
  }

  // Prevent removal of bot users; the refusal settles the row `failed` so a
  // later same-key retry cannot take over past the bot check.
  if (targetMember.isBot) {
    await settleOrgWriteFailed({
      row,
      user,
      intent: 'member_remove',
      outcomeCode: 'bot_removal_refused',
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Service account users cannot be removed',
    });
  }

  // Only an owner may act on an existing owner's membership. Runs after the
  // membership read so the admission stays before the mutable lookup.
  await assertKeyedOrgAuthority({
    row,
    ctx: args.ctx,
    user,
    organizationId,
    intent: 'member_remove',
    target: { currentRole: targetMember.role },
  });

  return executeOrgMemberRemove({ row, user, organizationId, memberId });
}

/**
 * Read-back-first takeover repair for a member removal: a read-back showing the
 * member already gone means the first attempt committed the removal without
 * settling, so complete the record (audit + settle + outbox + cleanup) and
 * replay instead of re-running the helper into the NOT_FOUND trap. Otherwise
 * the helper re-runs under the same row.
 *
 * Accepted trade-off (approved plan P1-A-08e item 7, Kilobot finding rejected
 * in round 2): an absent read-back is treated as the committed removal even
 * though the member could be absent for an unrelated reason. The `member_remove`
 * taxonomy is `reconcile-first`, so a same-key takeover implies a prior attempt
 * held the lease. `repairOrgRoleChange` follows the same decision.
 */
async function repairOrgMemberRemove(args: {
  row: OperationLedgerRow;
  ctx: TRPCContext;
  user: OrgActor;
  organizationId: string;
  memberId: string;
}): Promise<OrgWriteResult> {
  const { row, user, organizationId, memberId } = args;
  const [membership] = await db
    .select({
      role: organization_memberships.role,
      isBot: kilocode_users.is_bot,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, memberId)
      )
    )
    .limit(1);

  if (!membership) {
    return { ...(await completeOrgMemberRemoval(args)), replayed: true };
  }

  // Preserve the service-account guard on the takeover repair: a bot member
  // that is still present must never be removed by the read-back repair path.
  // Refuse exactly like the first-time path so a later same-key retry replays
  // the typed rejection instead of re-running the removal helper.
  if (membership.isBot) {
    await settleOrgWriteFailed({
      row,
      user,
      intent: 'member_remove',
      outcomeCode: 'bot_removal_refused',
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Service account users cannot be removed',
    });
  }

  // The first attempt may have crashed right after admission, so the takeover
  // path must not bypass the rule that only an owner may act on an existing
  // owner's membership.
  await assertKeyedOrgAuthority({
    row,
    ctx: args.ctx,
    user,
    organizationId,
    intent: 'member_remove',
    target: { currentRole: membership.role },
  });

  return { ...(await executeOrgMemberRemove(args)), replayed: true };
}

/**
 * Admits a keyed organization write and dispatches the admission outcome: first
 * execution, read-back repair (`takeover` / claimed `reconcile_pending`), replay
 * of a settled row, or CONFLICT while another attempt holds the lease. Reuse of
 * one key for a different intent or resource is rejected before any outcome is
 * honored.
 */
async function runOrgLedgerWrite(args: {
  user: OrgActor;
  organizationId: string;
  intent: OrgLedgerIntent;
  operationKey: string;
  resourceKey: string;
  first: (row: OperationLedgerRow) => Promise<OrgWriteResult>;
  repair: (row: OperationLedgerRow) => Promise<OrgWriteResult>;
  replay: (row: OperationLedgerRow) => OrgWriteResult | Promise<OrgWriteResult>;
}): Promise<OrgWriteResult> {
  const admission = await admitOperation(db, {
    userId: args.user.id,
    orgId: args.organizationId,
    domain: ORG_LEDGER_DOMAIN,
    intent: args.intent,
    operationKey: args.operationKey,
    resourceKey: args.resourceKey,
    taxonomy: 'reconcile-first',
    leaseSeconds: ORG_LEDGER_LEASE_SECONDS,
  });
  if (admission.row.intent !== args.intent || admission.row.resource_key !== args.resourceKey) {
    throw new TRPCError({ code: 'CONFLICT', message: ORG_OPERATION_KEY_REUSE_MISMATCH_MESSAGE });
  }
  switch (admission.admission) {
    case 'admitted':
      return args.first(admission.row);
    case 'takeover':
    case 'duplicate_reconcile_pending':
      return args.repair(admission.row);
    case 'duplicate_settled':
      return args.replay(admission.row);
    case 'duplicate_in_flight':
    case 'duplicate_reconcile_in_progress':
      throw new TRPCError({ code: 'CONFLICT', message: ORG_OPERATION_IN_PROGRESS_MESSAGE });
  }
}

export const organizationsMembersRouter = createTRPCRouter({
  listPublic: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(PublicOrganizationMembersSchema)
    .query(async ({ input }) => {
      return await getOrganizationMembers(input.organizationId);
    }),

  update: organizationAdminMutationProcedure
    .input(UpdateMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, memberId, role, dailyUsageLimitUsd, operationKey } = input;

      // Prevent users from changing their own role (P1-A-08e: retained before
      // every role-change path, including keyed ones, before any ledger write).
      if (role !== undefined && user.id === memberId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You cannot change your own role',
        });
      }

      // Limit-only update: existing path exactly, no ledger.
      if (role === undefined) {
        if (dailyUsageLimitUsd !== undefined) {
          const targetMember = await readOrgMemberRole(organizationId, memberId);
          if (!targetMember) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'User is not a member of this organization',
            });
          }

          await updateOrganizationUserLimit(organizationId, memberId, dailyUsageLimitUsd);
        }
        return successResult({ updated: 'limit' });
      }

      // Role change without an operationKey: existing path exactly.
      if (operationKey === undefined) {
        const targetMember = await readOrgMemberRole(organizationId, memberId);
        if (!targetMember) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'User is not a member of this organization',
          });
        }

        // Only an owner may grant the owner role or change an existing owner's
        // role; admins match owners everywhere else (P1-A-08e: retained before
        // the role-change helper).
        const actorRole = await ensureOrganizationAccess(
          ctx,
          organizationId,
          ORGANIZATION_MANAGE_ROLES
        );
        assertOwnerAuthority(actorRole, { currentRole: targetMember.role, nextRole: role });

        const result = await updateUserRoleInOrganization(organizationId, memberId, role);
        const updatedUser = await findUserById(memberId);
        const updatedUserEmail = updatedUser?.google_user_email || 'unknown';
        await createAuditLog({
          action: 'organization.member.change_role',
          actor_email: user.google_user_email,
          actor_id: user.id,
          actor_name: user.google_user_name,
          message: `Changed role for user ${updatedUserEmail} from ${targetMember.role} to ${role}`,
          organization_id: organizationId,
        });

        if (!result.success) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Failed to update user role',
          });
        }

        if (dailyUsageLimitUsd !== undefined) {
          await updateOrganizationUserLimit(organizationId, memberId, dailyUsageLimitUsd);
        }

        return successResult({ updated: ORG_ROLE_CHANGE_UPDATED });
      }

      // Role change with an operationKey: admit a ledger row BEFORE the mutable
      // membership lookup (P1-A-08e). A settled duplicate must replay even when
      // the member was removed after the original success; the existence read
      // therefore runs only on the `admitted` first execution.
      return runOrgLedgerWrite({
        user,
        organizationId,
        intent: 'member_role_change',
        operationKey,
        resourceKey: orgMemberRoleResourceKey(organizationId, memberId, role),
        first: row =>
          firstOrgRoleChange({
            row,
            ctx,
            user,
            organizationId,
            memberId,
            role,
            dailyUsageLimitUsd,
          }),
        repair: row =>
          repairOrgRoleChange({
            row,
            ctx,
            user,
            organizationId,
            memberId,
            role,
            dailyUsageLimitUsd,
          }),
        replay: replaySettledOrgRow,
      });
    }),
  setChildMemberships: organizationBillingMutationProcedure
    .input(SetChildMembershipsSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, memberId } = input;
      const childOrganizationIds = Array.from(new Set(input.childOrganizationIds));

      const directRole = user.is_admin
        ? 'owner'
        : await getDirectOrganizationRole(organizationId, user.id);
      if (directRole !== 'owner' && directRole !== 'billing_manager') {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have the required organizational role to access this feature',
        });
      }

      const [parentMember] = await db
        .select({
          email: kilocode_users.google_user_email,
          isBot: kilocode_users.is_bot,
        })
        .from(organization_memberships)
        .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
        .where(
          and(
            eq(organization_memberships.organization_id, organizationId),
            eq(organization_memberships.kilo_user_id, memberId)
          )
        )
        .limit(1);

      if (!parentMember || parentMember.isBot) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User is not a member of the parent organization',
        });
      }

      const childOrganizations = await db
        .select({
          id: organizations.id,
        })
        .from(organizations)
        .where(
          and(
            eq(organizations.parent_organization_id, organizationId),
            isNull(organizations.deleted_at)
          )
        );
      const childOrganizationsById = new Map(childOrganizations.map(child => [child.id, child]));

      if (
        childOrganizationIds.some(
          childOrganizationId => !childOrganizationsById.has(childOrganizationId)
        )
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Selected organizations must be direct child organizations',
        });
      }

      const childIds = childOrganizations.map(child => child.id);
      const existingMemberships =
        childIds.length > 0
          ? await db
              .select({
                organizationId: organization_memberships.organization_id,
                role: organization_memberships.role,
              })
              .from(organization_memberships)
              .where(
                and(
                  eq(organization_memberships.kilo_user_id, memberId),
                  inArray(organization_memberships.organization_id, childIds)
                )
              )
          : [];
      const existingMembershipsByOrganizationId = new Map(
        existingMemberships.map(membership => [membership.organizationId, membership])
      );
      const selectedChildOrganizationIds = new Set(childOrganizationIds);

      const added: string[] = [];
      const removed: string[] = [];

      for (const childOrganizationId of childOrganizationIds) {
        if (existingMembershipsByOrganizationId.has(childOrganizationId)) continue;

        const wasAdded = await addUserToOrganization(childOrganizationId, memberId, 'member');
        if (wasAdded) {
          added.push(childOrganizationId);
          await createAuditLog({
            action: 'organization.member.admin_add',
            actor_email: user.google_user_email,
            actor_id: user.id,
            actor_name: user.google_user_name,
            message: `Added parent organization member ${parentMember.email} as a member from parent organization ${organizationId}`,
            organization_id: childOrganizationId,
          });
        }
      }

      for (const membership of existingMemberships) {
        if (selectedChildOrganizationIds.has(membership.organizationId)) continue;

        const result = await removeUserFromOrganization(
          membership.organizationId,
          memberId,
          user.id
        );
        if ((result.rowCount ?? 0) > 0) {
          removed.push(membership.organizationId);
          await revokeGatewayStateForOrganizationMember(db, membership.organizationId, memberId);
          await createAuditLog({
            action: 'organization.member.remove',
            actor_email: user.google_user_email,
            actor_id: user.id,
            actor_name: user.google_user_name,
            message: `Removed parent organization member ${parentMember.email} from child organization via parent organization ${organizationId}`,
            organization_id: membership.organizationId,
          });
        }
      }

      return successResult({ added, removed });
    }),
  remove: organizationAdminMutationProcedure
    .input(RemoveMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, memberId, operationKey } = input;

      // Prevent users from removing themselves (unless they are kilo admin users)
      if (user.id === memberId && !user.is_admin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You cannot remove yourself from the organization',
        });
      }

      // Without an operationKey, use the existing path exactly: the target
      // membership lookup (missing-member NOT_FOUND + bot FORBIDDEN) runs
      // before the helper and no ledger row is written.
      if (operationKey === undefined) {
        const targetMember = await readOrgMemberWithBotFlag(organizationId, memberId);
        if (!targetMember) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'User is not a member of this organization',
          });
        }

        // Prevent removal of bot users
        if (targetMember.isBot) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Service account users cannot be removed',
          });
        }

        // Only an owner may act on an existing owner's membership; admins match
        // owners everywhere else.
        const actorRole = await ensureOrganizationAccess(
          ctx,
          organizationId,
          ORGANIZATION_MANAGE_ROLES
        );
        assertOwnerAuthority(actorRole, { currentRole: targetMember.role });

        const result = await removeUserFromOrganization(organizationId, memberId, user.id);
        if (result.rowCount === 0) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Failed to remove user from organization',
          });
        }

        const removedUser = await findUserById(memberId);
        await createAuditLog({
          action: 'organization.member.remove',
          actor_email: user.google_user_email,
          actor_id: user.id,
          actor_name: user.google_user_name,
          message: `Removed user ${removedUser?.google_user_email || 'unknown'}`,
          organization_id: organizationId,
        });

        await revokeGatewayStateForOrganizationMember(db, organizationId, memberId);
        await cleanupRemovedMemberInstances(memberId, organizationId);

        return successResult({ updated: memberId });
      }

      // With an operationKey, admit a ledger row BEFORE the missing-membership
      // precondition (P1-A-08e). A same-key retry after a lost response must
      // be able to replay a settled row or enter takeover repair when the
      // member is already removed; the precondition would otherwise reject the
      // retry with NOT_FOUND before the ledger could repair it. The permission
      // and bot checks are retained for a first-time (`admitted`) removal.
      return runOrgLedgerWrite({
        user,
        organizationId,
        intent: 'member_remove',
        operationKey,
        resourceKey: orgMemberRemoveResourceKey(organizationId, memberId),
        first: row => firstOrgMemberRemove({ row, ctx, user, organizationId, memberId }),
        repair: row => repairOrgMemberRemove({ row, ctx, user, organizationId, memberId }),
        // A settled completed removal whose gateway revocation was not recorded
        // complete retries the idempotent cleanup before replaying.
        replay: row => replaySettledOrgMemberRemoval({ row, organizationId, memberId }),
      });
    }),
  invite: organizationBillingMutationProcedure
    .input(InviteMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, email, role } = input;

      // Members can be invited by any billing-capable role; elevated roles
      // require organization-management authority, and only an owner may invite
      // another owner.
      if (role !== 'member') {
        const actorRole = await ensureOrganizationAccess(
          ctx,
          organizationId,
          ORGANIZATION_MANAGE_ROLES
        );
        assertOwnerAuthority(actorRole, { nextRole: role });
      }

      // Get organization details
      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      // Owners and Kilo admins can invite any role. Billing managers can invite members only.
      let invitation;
      try {
        invitation = await inviteUserToOrganization(organizationId, user.id, email, role);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === 'User already has a pending invitation') {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This email already has a pending invitation',
            });
          }
          if (error.message === 'User is already a member of this organization') {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This user is already a member of this organization',
            });
          }
          if (error.message === 'Child organizations cannot invite members') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Child organizations manage membership through their parent organization.',
            });
          }
          if (error.message === 'User must join this organization through SSO') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'This user must join through your organization SSO provider',
            });
          }
          if (error.message === 'Organization SSO policy is misconfigured') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'This organization has an invalid SSO configuration',
            });
          }
        }
        throw error;
      }
      const acceptInviteUrl = getAcceptInviteUrl(invitation.token);

      const emailResult = await sendOrganizationInviteEmail({
        to: email,
        organizationName: organization.name,
        inviterName: user.google_user_name,
        acceptInviteUrl,
      });

      if (!emailResult.sent) {
        // Expire the invitation so it doesn't block future invites to the same email
        await db
          .update(organization_invitations)
          .set({ expires_at: sql`NOW()` })
          .where(eq(organization_invitations.id, invitation.id));
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Unable to deliver the invitation email to this address. Please use a different email.',
        });
      }

      await createAuditLog({
        action: 'organization.user.send_invite',
        actor_email: user.google_user_email,
        actor_id: user.id,
        actor_name: user.google_user_name,
        message: `Invited ${email} as ${role}`,
        organization_id: organization.id,
      });

      return {
        acceptInviteUrl,
      };
    }),
  deleteInvite: organizationAdminMutationProcedure
    .input(DeleteInviteSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, inviteId } = input;

      // Find the invitation
      const [invitation] = await db
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.id, inviteId),
            eq(organization_invitations.organization_id, organizationId)
          )
        )
        .limit(1);

      if (!invitation) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Invitation not found',
        });
      }

      // Owners can revoke any invitation; admins cannot revoke an owner invite,
      // which is a pending grant of owner authority.
      const actorRole = await ensureOrganizationAccess(
        ctx,
        organizationId,
        ORGANIZATION_MANAGE_ROLES
      );
      assertOwnerAuthority(actorRole, { currentRole: invitation.role });

      // Expire the invitation by setting expires_at to NOW
      await db
        .update(organization_invitations)
        .set({ expires_at: sql`NOW()` })
        .where(eq(organization_invitations.id, inviteId));

      await createAuditLog({
        action: 'organization.user.revoke_invite',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: `Revoked invitation for ${invitation.email}`,
        organization_id: organizationId,
      });

      return successResult({
        updated: inviteId,
      });
    }),
});
