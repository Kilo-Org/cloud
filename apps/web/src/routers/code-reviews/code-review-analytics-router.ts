import * as z from 'zod';

import { getCodeReviewAnalyticsDashboard } from '@/lib/code-reviews/analytics/db';
import { setReviewAnalyticsEnabled } from '@/lib/code-reviews/analytics/settings';
import { readDb } from '@/lib/drizzle';
import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import { timedUsageQuery } from '@/lib/usage-query';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const PlatformSchema = z.enum(['github', 'gitlab']);
const AnalyticsPeriodDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);

const GetDashboardInputSchema = z.object({
  organizationId: z.uuid(),
  platform: PlatformSchema,
  periodDays: AnalyticsPeriodDaysSchema,
  repository: z.string().min(1).optional(),
});

const SetEnabledInputSchema = z.object({
  organizationId: z.uuid(),
  platform: PlatformSchema,
  enabled: z.boolean(),
});

export const codeReviewAnalyticsRouter = createTRPCRouter({
  getDashboard: baseProcedure.input(GetDashboardInputSchema).query(async ({ ctx, input }) => {
    const role = await ensureOrganizationAccess(ctx, input.organizationId);
    const owner = { type: 'org' as const, id: input.organizationId };
    const canManage = role === 'owner' || role === 'billing_manager';
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - input.periodDays * DAY_IN_MS);

    return timedUsageQuery(
      {
        db: readDb,
        route: 'codeReviews.analytics.getDashboard',
        queryLabel: 'code_review_analytics_dashboard',
        scope: 'org',
        period: `last-${input.periodDays}-days`,
      },
      tx =>
        getCodeReviewAnalyticsDashboard({
          db: tx,
          owner,
          platform: input.platform,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          repository: input.repository,
          canManage,
        })
    );
  }),

  setEnabled: baseProcedure.input(SetEnabledInputSchema).mutation(async ({ ctx, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'billing_manager']);

    const enabled = await setReviewAnalyticsEnabled({
      owner: { type: 'org', id: input.organizationId },
      platform: input.platform,
      enabled: input.enabled,
      createdBy: ctx.user.id,
    });

    return { enabled };
  }),
});
