import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationMemberProcedure,
  organizationOwnerMutationProcedure,
} from '@/routers/organizations/utils';
import { db, readDb } from '@/lib/drizzle';
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
import { getOrganizationMembers } from '@/lib/organizations/organizations';
import { TRPCError } from '@trpc/server';
import {
  getAgentInteractionsPerDay,
  getCloudAgentSessionsPerDay,
  getCodeReviewsPerDay,
} from '@/lib/organizations/organization-usage';
import { getAutocompleteAcceptedSuggestionsPerDay } from '@/lib/organizations/posthog-autocomplete-queries';
import {
  buildActivityDataMaps,
  generateDailyTimeseries,
  calculateUserScore,
  calculateWeeklyTrends,
} from '@/lib/organizations/ai-adoption-calculations';

const UsageTimeseriesInputSchema = OrganizationIdInputSchema.extend({
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
});

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
});

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
  dismissRecommendation: organizationOwnerMutationProcedure
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
  restoreRecommendation: organizationOwnerMutationProcedure
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
      const { organizationId, startDate, endDate } = input;

      // Fetch organization members (active only, not invited)
      const allMembers = await getOrganizationMembers(organizationId);
      const members = allMembers
        .filter((m): m is Extract<typeof m, { status: 'active' }> => m.status === 'active')
        .map(m => ({
          userId: m.id,
          email: m.email,
        }));

      if (members.length === 0) {
        return { timeseries: [], weeklyTrends: null, userScores: [], isNewOrganization: false };
      }

      const userIds = members.map(m => m.userId);

      // Extend start date by 14 days for 7-day lookback window + week-over-week comparison
      const extendedStartDate = new Date(startDate);
      extendedStartDate.setDate(extendedStartDate.getDate() - 14);
      const extendedStartDateStr = extendedStartDate.toISOString();

      // Get user emails for PostHog query
      const userEmails = members.map(m => m.email);

      // Fetch all component data in parallel
      const [agentInteractionsData, autocompleteData, cloudAgentSessionsData, codeReviewsData] =
        await Promise.all([
          getAgentInteractionsPerDay(organizationId, userIds, extendedStartDateStr, endDate),
          getAutocompleteAcceptedSuggestionsPerDay({
            organizationId,
            userEmails,
            startDate: extendedStartDateStr,
            endDate,
          }),
          getCloudAgentSessionsPerDay(userIds, extendedStartDateStr, endDate),
          getCodeReviewsPerDay(organizationId, userIds, extendedStartDateStr, endDate),
        ]);

      // Build activity data maps
      const activityData = buildActivityDataMaps(
        agentInteractionsData,
        autocompleteData,
        cloudAgentSessionsData,
        codeReviewsData
      );

      // Generate daily timeseries
      const { timeseries: data, userMetricsByDate } = generateDailyTimeseries(
        startDate,
        endDate,
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

      return { timeseries: data, weeklyTrends, userScores, isNewOrganization };
    }),
});
