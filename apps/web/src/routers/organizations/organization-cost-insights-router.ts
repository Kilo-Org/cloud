import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';

import { organization_memberships, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { adminProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import {
  buildCostInsightsDashboardData,
  buildCostInsightsEventHistoryData,
  buildCostInsightsSettingsData,
} from '@/lib/cost-insights/presenter';
import {
  acknowledgeCostInsightAlert,
  countOpenCostInsightReviewItems,
  dismissCostInsightSuggestion,
} from '@/lib/cost-insights/repository';
import {
  trackCostInsightsAlertAction,
  trackCostInsightsSuggestionAction,
  trackCostInsightsUiInteraction,
  type CostInsightsAuthorizedRole,
  type CostInsightsTrackingContext,
} from '@/lib/cost-insights/posthog-tracking';
import { OrganizationIdInputSchema } from './utils';
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
  const directRole = await getDirectCostInsightsRole(organizationId, ctx.user.id);
  const canManage = directRole === 'owner' || directRole === 'billing_manager';
  return {
    name,
    authorizedRole: canManage ? directRole : 'admin',
    readOnly: !canManage,
  } as const;
}

function organizationTrackingContext(
  userId: string,
  organizationId: string,
  authorizedRole: CostInsightsAuthorizedRole
): CostInsightsTrackingContext {
  return {
    distinctId: userId,
    userId,
    ownerType: 'organization',
    organizationId,
    authorizedRole,
  };
}

async function ensureOrgManageAccess(ctx: TRPCContext, organizationId: string) {
  const directRole = await getDirectCostInsightsRole(organizationId, ctx.user.id);
  if (directRole !== 'owner' && directRole !== 'billing_manager') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only an organization owner or billing manager can change Cost Insights.',
    });
  }
  return directRole;
}

export const organizationCostInsightsRouter = createTRPCRouter({
  trackUiInteraction: adminProcedure
    .input(costInsightsRouterInternals.OrganizationCostInsightsUiInteractionSchema)
    .mutation(async ({ ctx, input }) => {
      const access = await resolveOrgReadContext(ctx, input.organizationId);
      trackCostInsightsUiInteraction(
        organizationTrackingContext(ctx.user.id, input.organizationId, access.authorizedRole),
        input
      );
      return { success: true };
    }),
  trackSuggestionCta: adminProcedure
    .input(costInsightsRouterInternals.OrganizationCostInsightsSuggestionCtaSchema)
    .mutation(async ({ ctx, input }) => {
      const role = await ensureOrgManageAccess(ctx, input.organizationId);
      trackCostInsightsSuggestionAction({
        ...organizationTrackingContext(ctx.user.id, input.organizationId, role),
        action: 'open_cta',
        suggestionKind: input.suggestionKind,
        phase: 'clicked',
      });
      return { success: true };
    }),
  getDashboard: adminProcedure.input(OrganizationIdInputSchema).query(async ({ ctx, input }) => {
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
  getSettings: adminProcedure.input(OrganizationIdInputSchema).query(async ({ ctx, input }) => {
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
  listEvents: adminProcedure
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
  getAttentionState: adminProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ ctx, input }) => {
      await resolveOrgReadContext(ctx, input.organizationId);
      const reviewItemCount = await countOpenCostInsightReviewItems(db, {
        type: 'organization',
        id: input.organizationId,
      });
      return {
        attention: reviewItemCount > 0 ? 'alert' : 'none',
        reviewItemCount,
      };
    }),
  updateSettings: adminProcedure
    .input(
      OrganizationIdInputSchema.merge(costInsightsRouterInternals.UpdateCostInsightsSettingsSchema)
    )
    .mutation(async ({ ctx, input }) => {
      const role = await ensureOrgManageAccess(ctx, input.organizationId);
      return await costInsightsRouterInternals.updateOwnerSettings({
        owner: { type: 'organization', id: input.organizationId },
        actorUserId: ctx.user.id,
        trackingContext: organizationTrackingContext(ctx.user.id, input.organizationId, role),
        input,
      });
    }),
  acknowledgeAlert: adminProcedure
    .input(
      OrganizationIdInputSchema.merge(costInsightsRouterInternals.AcknowledgeCostInsightAlertSchema)
    )
    .mutation(async ({ ctx, input }) => {
      const role = await ensureOrgManageAccess(ctx, input.organizationId);
      const acknowledged = await acknowledgeCostInsightAlert(db, {
        owner: { type: 'organization', id: input.organizationId },
        alertKind: input.alertKind,
        eventId: input.eventId,
        actorUserId: ctx.user.id,
      });
      if (acknowledged) {
        trackCostInsightsAlertAction({
          ...organizationTrackingContext(ctx.user.id, input.organizationId, role),
          action: 'acknowledge',
          alertKind: input.alertKind,
        });
      }
      return { success: true };
    }),
  dismissSuggestion: adminProcedure
    .input(
      OrganizationIdInputSchema.merge(
        costInsightsRouterInternals.DismissCostInsightSuggestionSchema
      )
    )
    .mutation(async ({ ctx, input }) => {
      const role = await ensureOrgManageAccess(ctx, input.organizationId);
      const suggestionKind = await dismissCostInsightSuggestion(db, {
        owner: { type: 'organization', id: input.organizationId },
        suggestionId: input.suggestionId,
        actorUserId: ctx.user.id,
      });
      if (suggestionKind) {
        trackCostInsightsSuggestionAction({
          ...organizationTrackingContext(ctx.user.id, input.organizationId, role),
          action: 'dismiss',
          suggestionKind,
          phase: 'accepted',
        });
      }
      return { success: true };
    }),
});
