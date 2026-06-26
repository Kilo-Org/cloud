import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';

import { organization_memberships, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { createTRPCRouter, baseProcedure, type TRPCContext } from '@/lib/trpc/init';
import {
  buildCostInsightsDashboardData,
  buildCostInsightsEventHistoryData,
  buildCostInsightsSettingsData,
} from '@/lib/cost-insights/presenter';
import {
  acknowledgeCostInsightAlert,
  dismissCostInsightSuggestion,
  ownerHasUnreviewedCostInsightAlert,
} from '@/lib/cost-insights/repository';
import { ensureOrganizationAccess, OrganizationIdInputSchema } from './utils';
import { costInsightsRouterInternals } from '../cost-insights-router';

async function getDirectCostInsightsRole(organizationId: string, userId: string) {
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    );
  return membership?.role ?? null;
}

async function getOrganizationName(organizationId: string): Promise<string> {
  const [organization] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  return organization.name;
}

async function resolveOrgReadContext(ctx: TRPCContext, organizationId: string) {
  const name = await getOrganizationName(organizationId);
  if (ctx.user.is_admin) {
    const directRole = await getDirectCostInsightsRole(organizationId, ctx.user.id);
    const canManage = directRole === 'owner' || directRole === 'billing_manager';
    return {
      name,
      authorizedRole: canManage ? directRole : 'admin',
      readOnly: !canManage,
    } as const;
  }

  const role = await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
  return { name, authorizedRole: role, readOnly: false } as const;
}

async function ensureOrgManageAccess(ctx: TRPCContext, organizationId: string) {
  if (!ctx.user.is_admin) {
    await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
    return;
  }
  const directRole = await getDirectCostInsightsRole(organizationId, ctx.user.id);
  if (directRole !== 'owner' && directRole !== 'billing_manager') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only an organization owner or billing manager can change Cost Insights.',
    });
  }
}

export const organizationCostInsightsRouter = createTRPCRouter({
  getDashboard: baseProcedure.input(OrganizationIdInputSchema).query(async ({ ctx, input }) => {
    const access = await resolveOrgReadContext(ctx, input.organizationId);
    return await buildCostInsightsDashboardData({
      database: db,
      owner: { type: 'organization', id: input.organizationId },
      uiOwner: {
        type: 'organization',
        name: access.name,
        authorizedRole: access.authorizedRole,
      },
    });
  }),
  getSettings: baseProcedure.input(OrganizationIdInputSchema).query(async ({ ctx, input }) => {
    const access = await resolveOrgReadContext(ctx, input.organizationId);
    return await buildCostInsightsSettingsData({
      database: db,
      owner: { type: 'organization', id: input.organizationId },
      uiOwner: {
        type: 'organization',
        name: access.name,
        authorizedRole: access.authorizedRole,
      },
      readOnly: access.readOnly,
    });
  }),
  listEvents: baseProcedure
    .input(
      OrganizationIdInputSchema.merge(costInsightsRouterInternals.CostInsightEventHistorySchema)
    )
    .query(async ({ ctx, input }) => {
      await resolveOrgReadContext(ctx, input.organizationId);
      return await buildCostInsightsEventHistoryData({
        database: db,
        owner: { type: 'organization', id: input.organizationId },
        filter: input.filter,
        page: input.page,
        pageSize: input.pageSize,
      });
    }),
  getAttentionState: baseProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ ctx, input }) => {
      await resolveOrgReadContext(ctx, input.organizationId);
      return {
        attention: (await ownerHasUnreviewedCostInsightAlert(db, {
          type: 'organization',
          id: input.organizationId,
        }))
          ? 'alert'
          : 'none',
      };
    }),
  updateSettings: baseProcedure
    .input(
      OrganizationIdInputSchema.merge(costInsightsRouterInternals.UpdateCostInsightsSettingsSchema)
    )
    .mutation(async ({ ctx, input }) => {
      await ensureOrgManageAccess(ctx, input.organizationId);
      return await costInsightsRouterInternals.updateOwnerSettings({
        owner: { type: 'organization', id: input.organizationId },
        actorUserId: ctx.user.id,
        input,
      });
    }),
  acknowledgeAlert: baseProcedure
    .input(
      OrganizationIdInputSchema.merge(costInsightsRouterInternals.AcknowledgeCostInsightAlertSchema)
    )
    .mutation(async ({ ctx, input }) => {
      await ensureOrgManageAccess(ctx, input.organizationId);
      await acknowledgeCostInsightAlert(db, {
        owner: { type: 'organization', id: input.organizationId },
        alertKind: input.alertKind,
        actorUserId: ctx.user.id,
      });
      return { success: true };
    }),
  disableThreshold: baseProcedure
    .input(OrganizationIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      await ensureOrgManageAccess(ctx, input.organizationId);
      return await costInsightsRouterInternals.disableOwnerThreshold({
        owner: { type: 'organization', id: input.organizationId },
        actorUserId: ctx.user.id,
      });
    }),
  dismissSuggestion: baseProcedure
    .input(
      OrganizationIdInputSchema.merge(
        costInsightsRouterInternals.DismissCostInsightSuggestionSchema
      )
    )
    .mutation(async ({ ctx, input }) => {
      await ensureOrgManageAccess(ctx, input.organizationId);
      await dismissCostInsightSuggestion(db, {
        owner: { type: 'organization', id: input.organizationId },
        suggestionId: input.suggestionId,
        actorUserId: ctx.user.id,
      });
      return { success: true };
    }),
});
