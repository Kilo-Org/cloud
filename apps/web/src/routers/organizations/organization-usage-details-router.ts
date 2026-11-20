import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationMemberProcedure,
  organizationAdminMutationProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { organizations, organization_recommendation_dismissals } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import * as z from 'zod';
import {
  FEATURE_ADOPTION_KEYS,
  getOrganizationFeatureAdoption,
} from '@/lib/organizations/feature-adoption';
import {
  RECOMMENDATION_FEATURES,
  RECOMMENDATION_KEYS,
  getOrganizationRecommendations,
} from '@/lib/organizations/recommendations';
import { getOrganizationMembers } from '@kilocode/web-shared/lib/organizations/organizations';
import { TRPCError } from '@trpc/server';
import {
  getAgentInteractionsPerDay,
  getCloudAgentSessionsPerDay,
  getCodeReviewsPerDay,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  isBoundedReadError,
  withBoundedReplicaRead,
} from '@kilocode/web-shared/lib/organizations/bounded-replica-read';
import { roundAIAdoptionDateRange } from '@/lib/organizations/ai-adoption-date-range';
import { readCachedAIAdoption, writeCachedAIAdoption } from '@/lib/organizations/ai-adoption-cache';
import { getAutocompleteAcceptedSuggestionsPerDay } from '@/lib/organizations/posthog-autocomplete-queries';
import {
  buildActivityDataMaps,
  generateDailyTimeseries,
  calculateUserScore,
  calculateWeeklyTrends,
} from '@/lib/organizations/ai-adoption-calculations';

// The dashboard's longest period is a year; the margin covers calendar differences.
const MAX_ADOPTION_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

const UsageTimeseriesInputSchema = OrganizationIdInputSchema.extend({
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
}).refine(
  input => {
    const span = new Date(input.endDate).getTime() - new Date(input.startDate).getTime();
    return span >= 0 && span <= MAX_ADOPTION_RANGE_MS;
  },
  { message: 'The date range must be ascending and at most 400 days', path: ['endDate'] }
);

const FeatureAdoptionOutputSchema = z.object({
  checks: z.array(
    z.object({
      key: z.enum(FEATURE_ADOPTION_KEYS),
      title: z.string(),
      description: z.string(),
      adopted: z.boolean(),
      adoptedLabel: z.string(),
      notAdoptedLabel: z.string(),
      actionLabel: z.string(),
      actionUrl: z.string(),
    })
  ),
});

const RecommendationsOutputSchema = z.object({
  checks: FeatureAdoptionOutputSchema.shape.checks,
  recommendations: z.array(
    z.object({
      key: z.enum(RECOMMENDATION_KEYS),
      feature: z.enum(RECOMMENDATION_FEATURES),
      status: z.enum(['open', 'completed', 'dismissed']),
      title: z.string(),
      description: z.string(),
      actionLabel: z.string(),
      actionUrl: z.string(),
      severity: z.enum(['attention', 'suggestion']),
    })
  ),
});

const DismissRecommendationInputSchema = OrganizationIdInputSchema.extend({
  recommendationKey: z.enum(RECOMMENDATION_KEYS),
});

async function assertEnterprise(organizationId: string): Promise<void> {
  const rows = await readDb
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  if (rows[0]?.plan !== 'enterprise') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Feature adoption reporting is available on the Enterprise plan.',
    });
  }
}

const AIAdoptionTimeseriesOutputSchema = z.object({
  timeseries: z.array(
    z.object({
      datetime: z.string().datetime(),
      frequency: z.number(),
      depth: z.number(),
      coverage: z.number(),
    })
  ),
  weeklyTrends: z
    .object({
      frequency: z.object({
        change: z.number(),
        trend: z.enum(['up', 'down', 'neutral']),
      }),
      depth: z.object({
        change: z.number(),
        trend: z.enum(['up', 'down', 'neutral']),
      }),
      coverage: z.object({
        change: z.number(),
        trend: z.enum(['up', 'down', 'neutral']),
      }),
      total: z.object({
        change: z.number(),
        trend: z.enum(['up', 'down', 'neutral']),
      }),
    })
    .nullable(),
  userScores: z.array(
    z.object({
      frequency: z.number(),
      depth: z.number(),
      coverage: z.number(),
      total: z.number(),
    })
  ),
  isNewOrganization: z.boolean(), // True if first activity was < 3 days ago
  // True when a replica read was cancelled by its time bounds; the series above are empty.
  unavailable: z.boolean(),
});

const UNAVAILABLE_AI_ADOPTION = {
  timeseries: [],
  weeklyTrends: null,
  userScores: [],
  isNewOrganization: false,
  unavailable: true,
} satisfies z.infer<typeof AIAdoptionTimeseriesOutputSchema>;

async function computeAIAdoptionTimeseries(
  organizationId: string,
  startDate: string,
  endDate: string
): Promise<{
  members: number;
  response: z.infer<typeof AIAdoptionTimeseriesOutputSchema>;
}> {
  // Fetch organization members (active only, not invited)
  const allMembers = await withBoundedReplicaRead(tx => getOrganizationMembers(organizationId, tx));
  const members = allMembers
    .filter((m): m is Extract<typeof m, { status: 'active' }> => m.status === 'active')
    .map(m => ({
      userId: m.id,
      email: m.email,
    }));

  if (members.length === 0) {
    return {
      members: 0,
      response: {
        timeseries: [],
        weeklyTrends: null,
        userScores: [],
        isNewOrganization: false,
        unavailable: false,
      },
    };
  }

  // Extend start date by 14 days for 7-day lookback window + week-over-week comparison
  const extendedStartDate = new Date(startDate);
  extendedStartDate.setDate(extendedStartDate.getDate() - 14);
  const extendedStartDateStr = extendedStartDate.toISOString();

  // Get user emails for PostHog query
  const userEmails = members.map(m => m.email);

  // Fetch all component data in parallel
  const [agentInteractionsData, autocompleteData, cloudAgentSessionsData, codeReviewsData] =
    await Promise.all([
      withBoundedReplicaRead(tx =>
        getAgentInteractionsPerDay(organizationId, extendedStartDateStr, endDate, tx)
      ),
      getAutocompleteAcceptedSuggestionsPerDay({
        organizationId,
        userEmails,
        startDate: extendedStartDateStr,
        endDate,
      }),
      withBoundedReplicaRead(tx =>
        getCloudAgentSessionsPerDay(organizationId, extendedStartDateStr, endDate, tx)
      ),
      withBoundedReplicaRead(tx =>
        getCodeReviewsPerDay(organizationId, extendedStartDateStr, endDate, tx)
      ),
    ]);

  // Build activity data maps
  const activityData = buildActivityDataMaps(
    agentInteractionsData,
    autocompleteData,
    cloudAgentSessionsData,
    codeReviewsData
  );

  // Generate daily timeseries
  // The query range ends at the next hour boundary, which can be tomorrow's midnight.
  const seriesEnd = new Date(Math.min(new Date(endDate).getTime(), Date.now())).toISOString();
  const { timeseries: data, userMetricsByDate } = generateDailyTimeseries(
    startDate,
    seriesEnd,
    members,
    activityData
  );

  // Calculate trends
  const weeklyTrends = calculateWeeklyTrends(data);

  // Calculate per-user scores (anonymized - no identifying information)
  const userScores = members
    .map(member => calculateUserScore(member.userId, userMetricsByDate))
    .filter(score => score.total > 0);

  // Check if this is a new organization (first activity < 3 days ago)
  // Look at the earliest activity across all data sources
  const allDates = [
    ...agentInteractionsData.map(d => d.date),
    ...autocompleteData.map(d => d.date),
    ...cloudAgentSessionsData.map(d => d.date),
    ...codeReviewsData.map(d => d.date).filter(Boolean),
  ].sort();

  const firstActivityDate = allDates.length > 0 ? new Date(allDates[0]) : null;
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const isNewOrganization = firstActivityDate ? firstActivityDate > threeDaysAgo : true;

  return {
    members: members.length,
    response: {
      timeseries: data,
      weeklyTrends,
      userScores,
      isNewOrganization,
      unavailable: false,
    },
  };
}

export const organizationsUsageDetailsRouter = createTRPCRouter({
  getFeatureAdoption: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(FeatureAdoptionOutputSchema)
    .query(async ({ input }) => {
      const adoption = await getOrganizationFeatureAdoption(input.organizationId);
      if (adoption.plan !== 'enterprise') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Feature adoption reporting is available on the Enterprise plan.',
        });
      }
      return { checks: adoption.checks };
    }),
  getRecommendations: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(RecommendationsOutputSchema)
    .query(async ({ input }) => {
      const result = await getOrganizationRecommendations(input.organizationId);
      if (result.plan !== 'enterprise') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Feature adoption reporting is available on the Enterprise plan.',
        });
      }
      return { checks: result.checks, recommendations: result.recommendations };
    }),
  dismissRecommendation: organizationAdminMutationProcedure
    .input(DismissRecommendationInputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertEnterprise(input.organizationId);
      await db
        .insert(organization_recommendation_dismissals)
        .values({
          owned_by_organization_id: input.organizationId,
          recommendation_key: input.recommendationKey,
          dismissed_by_user_id: ctx.user.id,
        })
        .onConflictDoNothing({
          target: [
            organization_recommendation_dismissals.owned_by_organization_id,
            organization_recommendation_dismissals.recommendation_key,
          ],
        });
      return { dismissed: true };
    }),
  restoreRecommendation: organizationAdminMutationProcedure
    .input(DismissRecommendationInputSchema)
    .mutation(async ({ input }) => {
      await assertEnterprise(input.organizationId);
      await db
        .delete(organization_recommendation_dismissals)
        .where(
          and(
            eq(
              organization_recommendation_dismissals.owned_by_organization_id,
              input.organizationId
            ),
            eq(organization_recommendation_dismissals.recommendation_key, input.recommendationKey)
          )
        );
      return { restored: true };
    }),
  getAIAdoptionTimeseries: organizationMemberProcedure
    .input(UsageTimeseriesInputSchema)
    .output(AIAdoptionTimeseriesOutputSchema)
    .query(async ({ input }) => {
      const { organizationId } = input;
      const { startDate, endDate } = roundAIAdoptionDateRange(input);
      const cacheKey = { organizationId, startDate, endDate };

      const cached = await readCachedAIAdoption(cacheKey, AIAdoptionTimeseriesOutputSchema);
      if (cached) return cached;

      try {
        const result = await computeAIAdoptionTimeseries(organizationId, startDate, endDate);
        // The degraded result is never cached, so the next request retries the replica.
        if (result.members > 0) await writeCachedAIAdoption(cacheKey, result.response);
        return result.response;
      } catch (error) {
        if (!isBoundedReadError(error)) throw error;
        console.warn('AI adoption reads exceeded the replica bounds', {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return UNAVAILABLE_AI_ADOPTION;
      }
    }),
});
