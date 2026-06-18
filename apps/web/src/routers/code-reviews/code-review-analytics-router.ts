import * as z from 'zod';

import { getCodeReviewAnalyticsDashboard } from '@/lib/code-reviews/analytics/db';
import { setReviewAnalyticsEnabled } from '@/lib/code-reviews/analytics/settings';
import { readDb } from '@/lib/drizzle';
import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import { timedUsageQuery } from '@/lib/usage-query';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

const MAX_ANALYTICS_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;

const PlatformSchema = z.enum(['github', 'gitlab']);

const GetDashboardInputSchema = z
  .object({
    organizationId: z.uuid(),
    platform: PlatformSchema,
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    repository: z.string().min(1).optional(),
  })
  .refine(input => new Date(input.startDate).getTime() < new Date(input.endDate).getTime(), {
    message: 'Start date must be before end date',
    path: ['endDate'],
  })
  .refine(
    input =>
      new Date(input.endDate).getTime() - new Date(input.startDate).getTime() <=
      MAX_ANALYTICS_INTERVAL_MS,
    {
      message: 'Date interval cannot exceed 90 days',
      path: ['endDate'],
    }
  );

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

    return timedUsageQuery(
      {
        db: readDb,
        route: 'codeReviews.analytics.getDashboard',
        queryLabel: 'code_review_analytics_dashboard',
        scope: 'org',
        period: `${input.startDate}/${input.endDate}`,
      },
      tx =>
        getCodeReviewAnalyticsDashboard({
          db: tx,
          owner,
          platform: input.platform,
          startDate: input.startDate,
          endDate: input.endDate,
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
