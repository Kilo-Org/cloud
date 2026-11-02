import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { markPrivilegedGuard } from '@kilocode/web-shared/lib/admin/privileged-inventory';
import {
  SUPPORT_READ_MAX_DURATION_SECONDS,
  SUPPORT_WRITE_MAX_DURATION_SECONDS,
  observeOnlyStepUp,
} from '@kilocode/web-shared/lib/admin/support-access';
import {
  canCurrentUserRequestSupportOrgAccess,
  userIsSuperadmin,
} from '@/lib/admin/admin-permissions';
import { recordAdminAction } from '@/lib/admin/admin-action-audit';
import {
  approveSupportGrant,
  cancelSupportGrant,
  denySupportGrant,
  emergencyIssueSupportGrant,
  getActiveSupportGrantsForOrganization,
  listActiveSupportGrants,
  listMySupportGrants,
  listPendingSupportGrants,
  listUnreviewedEmergencyGrants,
  requestSupportGrant,
  reviewSupportGrant,
  revokeSupportGrant,
  toSupportGrantSummary,
} from '@/lib/admin/support-access-service';

const ReasonSchema = z.string().trim().min(10).max(2000);
const TicketReferenceSchema = z.string().trim().max(200).optional();
const ActionClassSchema = z.enum(['support_read', 'support_write']);

export const supportAccessRequesterProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, next }) => {
    if (!(await canCurrentUserRequestSupportOrgAccess(ctx.user.id))) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Support organization access requester permission required',
      });
    }
    return next();
  }, 'support_access_requester')
);

async function assertApproverPermission(userId: string): Promise<void> {
  const [canRequest, superadmin] = await Promise.all([
    canCurrentUserRequestSupportOrgAccess(userId),
    dbUserIsSuperadmin(userId),
  ]);
  if (!canRequest && !superadmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Support access approver permission required',
    });
  }
}

async function dbUserIsSuperadmin(userId: string): Promise<boolean> {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
  return user !== undefined && user.blocked_reason === null && userIsSuperadmin(user);
}

export const adminSupportAccessRouter = createTRPCRouter({
  request: supportAccessRequesterProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        actionClass: ActionClassSchema,
        reason: ReasonSchema,
        ticketReference: TicketReferenceSchema,
        durationSeconds: z
          .number()
          .int()
          .positive()
          .max(SUPPORT_READ_MAX_DURATION_SECONDS)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await observeOnlyStepUp.requireFresh({
        userId: ctx.user.id,
        action:
          input.actionClass === 'support_read' ? 'support_read_request' : 'support_write_request',
      });
      const grant = await requestSupportGrant({
        actorKiloUserId: ctx.user.id,
        organizationId: input.organizationId,
        actionClass: input.actionClass,
        reason: input.reason,
        ticketReference: input.ticketReference,
        durationSeconds: input.durationSeconds,
      });
      await recordAdminAction(ctx, {
        action: 'support_access.request',
        target: { type: 'organization', id: input.organizationId },
        message:
          input.actionClass === 'support_read'
            ? 'Requested support read access'
            : 'Requested support write access',
        metadata: { grantId: grant.id, actionClass: input.actionClass },
      });
      return toSupportGrantSummary(grant);
    }),

  approve: adminProcedure
    .input(
      z.object({
        grantId: z.uuid(),
        durationSeconds: z
          .number()
          .int()
          .positive()
          .max(SUPPORT_WRITE_MAX_DURATION_SECONDS)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertApproverPermission(ctx.user.id);
      await observeOnlyStepUp.requireFresh({
        userId: ctx.user.id,
        action: 'support_approval',
      });
      const grant = await approveSupportGrant({
        approverKiloUserId: ctx.user.id,
        grantId: input.grantId,
        durationSeconds: input.durationSeconds,
      });
      await recordAdminAction(ctx, {
        action: 'support_access.approve',
        target: { type: 'organization', id: grant.organization_id },
        message: 'Approved support write access',
        metadata: { grantId: grant.id },
      });
      return toSupportGrantSummary(grant);
    }),

  deny: adminProcedure.input(z.object({ grantId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await assertApproverPermission(ctx.user.id);
    const grant = await denySupportGrant({
      approverKiloUserId: ctx.user.id,
      grantId: input.grantId,
    });
    await recordAdminAction(ctx, {
      action: 'support_access.deny',
      target: { type: 'organization', id: grant.organization_id },
      message: 'Denied support write access',
      metadata: { grantId: grant.id },
    });
    return toSupportGrantSummary(grant);
  }),

  cancel: supportAccessRequesterProcedure
    .input(z.object({ grantId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const grant = await cancelSupportGrant({
        actorKiloUserId: ctx.user.id,
        grantId: input.grantId,
      });
      await recordAdminAction(ctx, {
        action: 'support_access.cancel',
        target: { type: 'organization', id: grant.organization_id },
        message: 'Cancelled support access request',
        metadata: { grantId: grant.id },
      });
      return toSupportGrantSummary(grant);
    }),

  revoke: adminProcedure
    .input(z.object({ grantId: z.uuid(), reason: ReasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const grant = await revokeSupportGrant({
        actorKiloUserId: ctx.user.id,
        grantId: input.grantId,
        reason: input.reason,
      });
      await recordAdminAction(ctx, {
        action: 'support_access.revoke',
        target: { type: 'organization', id: grant.organization_id },
        message: 'Revoked support access',
        metadata: { grantId: grant.id },
      });
      return toSupportGrantSummary(grant);
    }),

  emergencyIssue: adminProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        reason: ReasonSchema,
        ticketReference: TicketReferenceSchema,
        durationSeconds: z
          .number()
          .int()
          .positive()
          .max(SUPPORT_WRITE_MAX_DURATION_SECONDS)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await dbUserIsSuperadmin(ctx.user.id))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Superadmin access required' });
      }
      const grant = await emergencyIssueSupportGrant({
        superadminKiloUserId: ctx.user.id,
        organizationId: input.organizationId,
        reason: input.reason,
        ticketReference: input.ticketReference,
        durationSeconds: input.durationSeconds,
      });
      await recordAdminAction(ctx, {
        action: 'support_access.emergency_issue',
        target: { type: 'organization', id: grant.organization_id },
        message: 'Issued emergency support write access',
        metadata: { grantId: grant.id },
      });
      return toSupportGrantSummary(grant);
    }),

  review: adminProcedure.input(z.object({ grantId: z.uuid() })).mutation(async ({ ctx, input }) => {
    if (!(await dbUserIsSuperadmin(ctx.user.id))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Superadmin access required' });
    }
    const grant = await reviewSupportGrant({
      reviewerKiloUserId: ctx.user.id,
      grantId: input.grantId,
    });
    await recordAdminAction(ctx, {
      action: 'support_access.review',
      target: { type: 'organization', id: grant.organization_id },
      message: 'Reviewed emergency support access',
      metadata: { grantId: grant.id },
    });
    return toSupportGrantSummary(grant);
  }),

  listMine: supportAccessRequesterProcedure.query(async ({ ctx }) => {
    const grants = await listMySupportGrants(ctx.user.id);
    return grants.map(toSupportGrantSummary);
  }),

  listPending: adminProcedure.query(async ({ ctx }) => {
    await assertApproverPermission(ctx.user.id);
    const grants = await listPendingSupportGrants();
    return grants.map(toSupportGrantSummary);
  }),

  listActive: adminProcedure.query(async ({ ctx }) => {
    await assertApproverPermission(ctx.user.id);
    const grants = await listActiveSupportGrants();
    return grants.map(toSupportGrantSummary);
  }),

  listUnreviewedEmergency: adminProcedure.query(async ({ ctx }) => {
    if (!(await dbUserIsSuperadmin(ctx.user.id))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Superadmin access required' });
    }
    const grants = await listUnreviewedEmergencyGrants();
    return grants.map(toSupportGrantSummary);
  }),

  getActiveForOrganization: adminProcedure
    .input(z.object({ organizationId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      await assertApproverPermission(ctx.user.id);
      const grants = await getActiveSupportGrantsForOrganization(input.organizationId);
      return grants.map(toSupportGrantSummary);
    }),
});
