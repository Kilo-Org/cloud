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
  type OperationLedgerRow,
} from '@kilocode/db/schema';
import { db, sql, type DrizzleTransaction } from '@/lib/drizzle';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  ensureOrganizationAccess,
  OrganizationIdInputSchema,
  organizationBillingMutationProcedure,
  organizationMemberProcedure,
  organizationOwnerMutationProcedure,
} from '@/routers/organizations/utils';
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
import { PublicOrganizationMembersSchema } from '@/lib/organizations/organization-types';
import {
  admitOperation,
  settleOperation,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';

const MAX_DAILY_LIMIT_USD = 2000;

const operationKeySchema = z.string().min(1).max(128).optional();

const UpdateMemberSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  role: z.enum(['owner', 'member', 'billing_manager']).optional(),
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
  role: z.enum(['owner', 'member', 'billing_manager']),
});

const DeleteInviteSchema = OrganizationIdInputSchema.extend({
  inviteId: z.string(),
});

const SetChildMembershipsSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  childOrganizationIds: z.array(z.uuid()),
});

async function getDirectOrganizationRole(
  organizationId: string,
  userId: string
): Promise<'owner' | 'member' | 'billing_manager' | null> {
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
// admits an `organization`-domain ledger row BEFORE the mutable membership
// lookup, and only then executes. Later same-key calls dedupe, replay the
// canonical result, or conflict. After a successful helper commit, the success
// audit log, the terminal settle, and the `organization_write_settled` outbox
// event are written in ONE transaction (atomic). A failed helper result
// settles the row `failed` without a success audit or success outbox. A
// takeover/reconcile retry reads the membership back FIRST: an already-applied
// role or an already-removed member settles completed and replays, which
// avoids the NOT_FOUND trap of re-running the helper on the already-applied
// state. For member removal the ledger admission runs BEFORE the
// missing-membership precondition: a retry of an already-removed member must
// reach the settled replay or takeover repair instead of being rejected with
// NOT_FOUND first; the permission and bot checks are retained for a
// first-time removal. For keyed role changes the same admission-before-lookup
// order holds: a settled role change replays even when the member was removed
// after the original success, and a takeover read-back that finds the member
// gone (the keyed path reads membership only after admission, so an absent
// read-back means the member was removed after the original success) completes
// the record as completed and replays. The membership helpers and the
// `dailyUsageLimitUsd` path are unchanged.

const ORG_LEDGER_DOMAIN = 'organization' as const;
/** The in-flight window: while an `admitted` row holds a live lease, same-key
 *  retries receive CONFLICT `operation_in_progress` instead of re-running. */
const ORG_LEDGER_LEASE_SECONDS = 120;

const ORG_LEDGER_INTENTS = ['member_role_change', 'member_remove'] as const;
type OrgLedgerIntent = (typeof ORG_LEDGER_INTENTS)[number];

const ORG_OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
const ORG_REPLAY_FAILED_MESSAGE = 'This action did not complete. Please try again.';
const ORG_OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';
// A provider-confirmed outcome whose ledger settle failed: the membership
// helper DID commit, but the row was not settled. Never surface a success
// receipt for an un-recorded row — a same-key retry repairs by read-back.
const ORG_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';

function orgOperationInProgressError(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: ORG_OPERATION_IN_PROGRESS_MESSAGE });
}

function orgOperationKeyReuseMismatchError(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: ORG_OPERATION_KEY_REUSE_MISMATCH_MESSAGE });
}

/** `organization_write_settled` outbox payload (DEC-05): no free text, no resource keys. */
function orgSettledOutboxEvent(params: {
  distinctId: string;
  intent: OrgLedgerIntent;
  outcome: 'completed' | 'failed';
}): OutboxEventInput {
  return {
    eventName: 'organization_write_settled',
    distinctId: params.distinctId,
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
 * Best-effort ledger write, reserved for FAILED-status settles only: the
 * caller is already receiving a typed rejection, so a ledger write that fails
 * here must never mask the helper outcome.
 */
async function bestEffortOrgLedgerWrite(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(
      `Failed to write organization operation ledger row: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Replays a terminal row: only `completed`/`no_op` may replay a canonical result. */
function replaySettledOrgRow<T>(row: OperationLedgerRow): T {
  if (row.status === 'completed' || row.status === 'no_op') {
    return { success: true, ...(row.canonical_result ?? {}), replayed: true } as T;
  }
  throw new TRPCError({ code: 'BAD_REQUEST', message: ORG_REPLAY_FAILED_MESSAGE });
}

/**
 * Durably settles a provider-confirmed org outcome as `completed` with the
 * success outbox event inside the SAME transaction as the success audit log.
 * A settle failure must never yield a success receipt for an un-recorded row.
 */
async function settleOrgCompletedInTransaction(args: {
  tx: DrizzleTransaction;
  row: OperationLedgerRow;
  canonicalResult: Record<string, unknown>;
  outboxEvent: OutboxEventInput;
}): Promise<void> {
  try {
    await settleOperation(args.tx, {
      rowId: args.row.id,
      status: 'completed',
      outcomeCode: 'ok',
      canonicalResult: args.canonicalResult,
      outboxEvent: args.outboxEvent,
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
}

type OrgActor = {
  id: string;
  google_user_email: string | null;
  google_user_name: string | null;
  is_admin: boolean;
};

/**
 * Runs the role-change helper under an already-admitted row and, after the
 * helper commits, writes the success audit log + terminal settle + outbox in
 * one transaction. A failed helper result settles the row `failed` without a
 * success audit or success outbox.
 */
async function executeOrgRoleChange(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  memberId: string;
  role: 'owner' | 'member' | 'billing_manager';
  dailyUsageLimitUsd?: number | null;
  targetMember?: { role: string };
}): Promise<SuccessResult<{ updated: string }>> {
  const { organizationId, memberId, role } = args;
  const distinctId = args.user.google_user_email || args.user.id;

  const result = await updateUserRoleInOrganization(organizationId, memberId, role);
  if (!result.success) {
    await bestEffortOrgLedgerWrite(() =>
      settleOperation(db, {
        rowId: args.row.id,
        status: 'failed',
        outcomeCode: 'role_change_failed',
        outboxEvent: orgSettledOutboxEvent({
          distinctId,
          intent: 'member_role_change',
          outcome: 'failed',
        }),
      })
    );
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Failed to update user role',
    });
  }

  if (args.dailyUsageLimitUsd !== undefined && args.targetMember) {
    await updateOrganizationUserLimit(organizationId, memberId, args.dailyUsageLimitUsd);
  }

  const updatedUser = await findUserById(memberId);
  const updatedUserEmail = updatedUser?.google_user_email || 'unknown';
  const updated = 'role and limit';

  await db.transaction(async tx => {
    await createAuditLog({
      action: 'organization.member.change_role',
      actor_email: args.user.google_user_email,
      actor_id: args.user.id,
      actor_name: args.user.google_user_name,
      message: `Changed role for user ${updatedUserEmail} from ${args.targetMember?.role ?? 'unknown'} to ${role}`,
      organization_id: organizationId,
      tx,
    });
    await settleOrgCompletedInTransaction({
      tx,
      row: args.row,
      canonicalResult: { updated },
      outboxEvent: orgSettledOutboxEvent({
        distinctId,
        intent: 'member_role_change',
        outcome: 'completed',
      }),
    });
  });

  return successResult({ updated });
}

/**
 * Read-back-first takeover repair for a role change: if the read-back shows
 * the target role already applied, the first attempt committed the change
 * without settling — settle completed and replay without re-running the
 * helper (avoiding the NOT_FOUND trap). If the member is gone, the keyed path
 * reads membership only after admission and settles `failed` when the member
 * is absent on first execution, so an absent read-back here means the original
 * success committed and the member was REMOVED later: complete the record as
 * completed and replay instead of failing on the mutable membership state.
 * Otherwise re-run the helper under the same row.
 */
async function repairOrgRoleChange(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  memberId: string;
  role: 'owner' | 'member' | 'billing_manager';
  dailyUsageLimitUsd?: number | null;
}): Promise<SuccessResult<{ updated: string }>> {
  const distinctId = args.user.google_user_email || args.user.id;
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, args.organizationId),
        eq(organization_memberships.kilo_user_id, args.memberId)
      )
    )
    .limit(1);

  if (!membership) {
    const updatedUser = await findUserById(args.memberId);
    const updatedUserEmail = updatedUser?.google_user_email || 'unknown';
    await db.transaction(async tx => {
      await createAuditLog({
        action: 'organization.member.change_role',
        actor_email: args.user.google_user_email,
        actor_id: args.user.id,
        actor_name: args.user.google_user_name,
        message: `Changed role for user ${updatedUserEmail} from unknown to ${args.role}`,
        organization_id: args.organizationId,
        tx,
      });
      await settleOrgCompletedInTransaction({
        tx,
        row: args.row,
        canonicalResult: { updated: 'role and limit' },
        outboxEvent: orgSettledOutboxEvent({
          distinctId,
          intent: 'member_role_change',
          outcome: 'completed',
        }),
      });
    });
    return successResult({ updated: 'role and limit', replayed: true });
  }

  if (membership.role === args.role) {
    const updatedUser = await findUserById(args.memberId);
    const updatedUserEmail = updatedUser?.google_user_email || 'unknown';
    await db.transaction(async tx => {
      await createAuditLog({
        action: 'organization.member.change_role',
        actor_email: args.user.google_user_email,
        actor_id: args.user.id,
        actor_name: args.user.google_user_name,
        message: `Changed role for user ${updatedUserEmail} from ${membership.role} to ${args.role}`,
        organization_id: args.organizationId,
        tx,
      });
      await settleOrgCompletedInTransaction({
        tx,
        row: args.row,
        canonicalResult: { updated: 'role and limit' },
        outboxEvent: orgSettledOutboxEvent({
          distinctId,
          intent: 'member_role_change',
          outcome: 'completed',
        }),
      });
    });
    return successResult({ updated: 'role and limit', replayed: true });
  }

  // Not applied yet: re-run the helper under the same row (takeover).
  return executeOrgRoleChange({
    ...args,
    targetMember: { role: membership.role },
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

/** Transactional success audit + settle + outbox, then existing post-removal side effects. */
async function completeOrgMemberRemoval(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  memberId: string;
}): Promise<SuccessResult<{ updated: string }>> {
  const distinctId = args.user.google_user_email || args.user.id;
  const removedUser = await findUserById(args.memberId);

  await db.transaction(async tx => {
    await createAuditLog({
      action: 'organization.member.remove',
      actor_email: args.user.google_user_email,
      actor_id: args.user.id,
      actor_name: args.user.google_user_name,
      message: `Removed user ${removedUser?.google_user_email || 'unknown'}`,
      organization_id: args.organizationId,
      tx,
    });
    await settleOrgCompletedInTransaction({
      tx,
      row: args.row,
      canonicalResult: { updated: args.memberId },
      outboxEvent: orgSettledOutboxEvent({
        distinctId,
        intent: 'member_remove',
        outcome: 'completed',
      }),
    });
  });

  await revokeGatewayStateForOrganizationMember(db, args.organizationId, args.memberId);
  await cleanupRemovedMemberInstances(args.memberId, args.organizationId);

  return successResult({ updated: args.memberId });
}

/** Best-effort failed settle for a member-removal row; never masks the typed rejection. */
async function settleOrgMemberRemovalFailed(args: {
  row: OperationLedgerRow;
  distinctId: string;
  outcomeCode: string;
}): Promise<void> {
  await bestEffortOrgLedgerWrite(() =>
    settleOperation(db, {
      rowId: args.row.id,
      status: 'failed',
      outcomeCode: args.outcomeCode,
      outboxEvent: orgSettledOutboxEvent({
        distinctId: args.distinctId,
        intent: 'member_remove',
        outcome: 'failed',
      }),
    })
  );
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
}): Promise<SuccessResult<{ updated: string }>> {
  const distinctId = args.user.google_user_email || args.user.id;
  const result = await removeUserFromOrganization(args.organizationId, args.memberId, args.user.id);
  if (result.rowCount === 0) {
    await settleOrgMemberRemovalFailed({
      row: args.row,
      distinctId,
      outcomeCode: 'member_absent',
    });
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Failed to remove user from organization',
    });
  }
  return completeOrgMemberRemoval(args);
}

/**
 * Read-back-first takeover repair for a member removal: if the read-back shows
 * the member already gone, the first attempt committed the removal without
 * settling — complete the record (audit + settle + outbox + side effects) and
 * replay without re-running the helper (avoiding the NOT_FOUND trap).
 * Otherwise re-run the helper under the same row.
 */
async function repairOrgMemberRemove(args: {
  row: OperationLedgerRow;
  user: OrgActor;
  organizationId: string;
  memberId: string;
}): Promise<SuccessResult<{ updated: string; replayed: true }>> {
  const [membership] = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, args.organizationId),
        eq(organization_memberships.kilo_user_id, args.memberId)
      )
    )
    .limit(1);

  if (!membership) {
    const completed = await completeOrgMemberRemoval(args);
    return { ...completed, replayed: true };
  }
  const completed = await executeOrgMemberRemove(args);
  return { ...completed, replayed: true };
}

export const organizationsMembersRouter = createTRPCRouter({
  listPublic: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(PublicOrganizationMembersSchema)
    .query(async ({ input }) => {
      return await getOrganizationMembers(input.organizationId);
    }),

  update: organizationOwnerMutationProcedure
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
          const [targetMember] = await db
            .select({ role: organization_memberships.role })
            .from(organization_memberships)
            .where(
              and(
                eq(organization_memberships.organization_id, organizationId),
                eq(organization_memberships.kilo_user_id, memberId)
              )
            );

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
        const [targetMember] = await db
          .select({ role: organization_memberships.role })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, organizationId),
              eq(organization_memberships.kilo_user_id, memberId)
            )
          );

        if (!targetMember) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'User is not a member of this organization',
          });
        }

        const result = await updateUserRoleInOrganization(organizationId, memberId, role);
        const updatedUser = await findUserById(memberId);
        const updatedUserEmail = updatedUser?.google_user_email || 'unknown';
        await createAuditLog({
          action: 'organization.member.change_role',
          actor_email: user.google_user_email,
          actor_id: user.id,
          actor_name: user.google_user_name,
          message: `Changed role for user ${updatedUserEmail} from ${targetMember?.role} to ${role}`,
          organization_id: organizationId,
        });

        if (!result.success) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Failed to update user role',
          });
        }

        if (dailyUsageLimitUsd !== undefined && targetMember) {
          await updateOrganizationUserLimit(organizationId, memberId, dailyUsageLimitUsd);
        }

        return successResult({ updated: 'role and limit' });
      }

      // Role change with an operationKey: admit a ledger row BEFORE the mutable
      // membership lookup (P1-A-08e). A settled duplicate must replay even when
      // the member was removed after the original success; the existence read
      // therefore runs only on the `admitted` first execution.
      const resourceKey = orgMemberRoleResourceKey(organizationId, memberId, role);
      const admission = await admitOperation(db, {
        userId: user.id,
        orgId: organizationId,
        domain: ORG_LEDGER_DOMAIN,
        intent: 'member_role_change',
        operationKey,
        resourceKey,
        taxonomy: 'reconcile-first',
        leaseSeconds: ORG_LEDGER_LEASE_SECONDS,
      });
      if (
        admission.row.intent !== 'member_role_change' ||
        admission.row.resource_key !== resourceKey
      ) {
        throw orgOperationKeyReuseMismatchError();
      }
      switch (admission.admission) {
        case 'admitted': {
          const distinctId = user.google_user_email || user.id;
          const [targetMember] = await db
            .select({ role: organization_memberships.role })
            .from(organization_memberships)
            .where(
              and(
                eq(organization_memberships.organization_id, organizationId),
                eq(organization_memberships.kilo_user_id, memberId)
              )
            );

          // A first-time role change of an absent member settles the row
          // `failed` so a later same-key retry replays the failure instead of
          // taking over past the membership check.
          if (!targetMember) {
            await bestEffortOrgLedgerWrite(() =>
              settleOperation(db, {
                rowId: admission.row.id,
                status: 'failed',
                outcomeCode: 'member_absent',
                outboxEvent: orgSettledOutboxEvent({
                  distinctId,
                  intent: 'member_role_change',
                  outcome: 'failed',
                }),
              })
            );
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'User is not a member of this organization',
            });
          }

          return executeOrgRoleChange({
            row: admission.row,
            user,
            organizationId,
            memberId,
            role,
            dailyUsageLimitUsd,
            targetMember,
          });
        }
        case 'takeover':
        case 'duplicate_reconcile_pending':
          return repairOrgRoleChange({
            row: admission.row,
            user,
            organizationId,
            memberId,
            role,
            dailyUsageLimitUsd,
          });
        case 'duplicate_settled':
          return replaySettledOrgRow(admission.row);
        case 'duplicate_in_flight':
        case 'duplicate_reconcile_in_progress':
          throw orgOperationInProgressError();
      }
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
  remove: organizationOwnerMutationProcedure
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
        const [targetMember] = await db
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
      const resourceKey = orgMemberRemoveResourceKey(organizationId, memberId);
      const admission = await admitOperation(db, {
        userId: user.id,
        orgId: organizationId,
        domain: ORG_LEDGER_DOMAIN,
        intent: 'member_remove',
        operationKey,
        resourceKey,
        taxonomy: 'reconcile-first',
        leaseSeconds: ORG_LEDGER_LEASE_SECONDS,
      });
      if (admission.row.intent !== 'member_remove' || admission.row.resource_key !== resourceKey) {
        throw orgOperationKeyReuseMismatchError();
      }
      switch (admission.admission) {
        case 'admitted': {
          const distinctId = user.google_user_email || user.id;
          const [targetMember] = await db
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

          // A first-time removal of a member that is already gone settles the
          // row `failed` so a later same-key retry replays the failure instead
          // of taking over into the removal helper.
          if (!targetMember) {
            await settleOrgMemberRemovalFailed({
              row: admission.row,
              distinctId,
              outcomeCode: 'member_absent',
            });
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'User is not a member of this organization',
            });
          }

          // Prevent removal of bot users; the refusal settles the row `failed`
          // so a later same-key retry cannot take over past the bot check.
          if (targetMember.isBot) {
            await settleOrgMemberRemovalFailed({
              row: admission.row,
              distinctId,
              outcomeCode: 'bot_removal_refused',
            });
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Service account users cannot be removed',
            });
          }

          return executeOrgMemberRemove({
            row: admission.row,
            user,
            organizationId,
            memberId,
          });
        }
        case 'takeover':
        case 'duplicate_reconcile_pending':
          return repairOrgMemberRemove({
            row: admission.row,
            user,
            organizationId,
            memberId,
          });
        case 'duplicate_settled':
          return replaySettledOrgRow(admission.row);
        case 'duplicate_in_flight':
        case 'duplicate_reconcile_in_progress':
          throw orgOperationInProgressError();
      }
    }),
  invite: organizationBillingMutationProcedure
    .input(InviteMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, email, role } = input;

      if (role !== 'member') {
        await ensureOrganizationAccess(ctx, organizationId, ['owner']);
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
  deleteInvite: organizationOwnerMutationProcedure
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

      // Owners can delete any invitation
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
