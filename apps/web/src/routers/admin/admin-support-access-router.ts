import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  SUPPORT_READ_MAX_DURATION_SECONDS,
  SUPPORT_WRITE_MAX_DURATION_SECONDS,
  isSupportAccessEnabled,
} from '@kilocode/web-shared/lib/admin/support-access';
import { supportStepUpPort } from '@kilocode/web-shared/lib/admin/support-step-up';
import { loadEffectiveMembershipRows } from '@kilocode/web-shared/routers/organizations/utils';
import { userIsSuperadmin } from '@/lib/admin/admin-permissions';
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
  toSupportGrantListItems,
  toSupportGrantSummary,
} from '@/lib/admin/support-access-service';

const ReasonSchema = z.string().trim().min(10).max(2000);
const TicketReferenceSchema = z.string().trim().max(200).optional();
const ActionClassSchema = z.enum(['support_read', 'support_write']);

function assertSupportAccessEnabled(): void {
  if (!isSupportAccessEnabled()) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Support access is disabled',
      cause: { supportAccessReason: 'support_access_disabled' },
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
  request: adminProcedure
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
      assertSupportAccessEnabled();
      if (input.actionClass === 'support_write') {
        await supportStepUpPort.requireFresh({
          userId: ctx.user.id,
          action: 'support_write_request',
          credential: ctx.credential,
          webSessionId: ctx.webSessionId ?? null,
          route: ctx.trpcPath ?? null,
          method: ctx.trpcType ?? null,
          surface: 'trpc',
        });
      }
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
      assertSupportAccessEnabled();
      if (isSupportAccessEnabled()) {
        await supportStepUpPort.requireFresh({
          userId: ctx.user.id,
          action: 'support_approval',
          credential: ctx.credential,
          webSessionId: ctx.webSessionId ?? null,
          route: ctx.trpcPath ?? null,
          method: ctx.trpcType ?? null,
          surface: 'trpc',
        });
      }
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
    assertSupportAccessEnabled();
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

  cancel: adminProcedure.input(z.object({ grantId: z.uuid() })).mutation(async ({ ctx, input }) => {
    assertSupportAccessEnabled();
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
      assertSupportAccessEnabled();
      if (!(await dbUserIsSuperadmin(ctx.user.id))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Superadmin access required' });
      }
      await supportStepUpPort.requireFresh({
        userId: ctx.user.id,
        action: 'support_emergency_issue',
        credential: ctx.credential,
        webSessionId: ctx.webSessionId ?? null,
        route: ctx.trpcPath ?? null,
        method: ctx.trpcType ?? null,
        surface: 'trpc',
      });
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
    assertSupportAccessEnabled();
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

  listMine: adminProcedure.query(async ({ ctx }) => {
    const grants = await listMySupportGrants(ctx.user.id);
    return toSupportGrantListItems(grants);
  }),

  listPending: adminProcedure.query(async () => {
    const grants = await listPendingSupportGrants();
    return toSupportGrantListItems(grants);
  }),

  listActive: adminProcedure.query(async () => {
    const grants = await listActiveSupportGrants();
    return toSupportGrantListItems(grants);
  }),

  listUnreviewedEmergency: adminProcedure.query(async ({ ctx }) => {
    if (!(await dbUserIsSuperadmin(ctx.user.id))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Superadmin access required' });
    }
    const grants = await listUnreviewedEmergencyGrants();
    return toSupportGrantListItems(grants);
  }),

  viewAccess: adminProcedure
    .input(z.object({ organizationId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      if (!isSupportAccessEnabled()) return { grantRequired: false, expiresAt: null };
      const [memberships, grants] = await Promise.all([
        loadEffectiveMembershipRows(ctx.user.id, input.organizationId),
        getActiveSupportGrantsForOrganization(input.organizationId),
      ]);
      if (memberships.length > 0) return { grantRequired: false, expiresAt: null };
      const now = Date.now();
      const ownGrant = grants.find(
        grant =>
          grant.actor_kilo_user_id === ctx.user.id &&
          grant.expires_at !== null &&
          new Date(grant.expires_at).getTime() > now
      );
      return ownGrant
        ? { grantRequired: false, expiresAt: ownGrant.expires_at }
        : { grantRequired: true, expiresAt: null };
    }),
  getActiveForOrganization: adminProcedure
    .input(z.object({ organizationId: z.uuid() }))
    .query(async ({ input }) => {
      const grants = await getActiveSupportGrantsForOrganization(input.organizationId);
      return toSupportGrantListItems(grants);
    }),
});
