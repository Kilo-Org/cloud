import type { UsageDetails } from '@/lib/organizations/organization-types';
import { TimePeriodSchema } from '@/lib/organizations/organization-types';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { db } from '@/lib/drizzle';
import {
  microdollar_usage,
  kilocode_users,
  microdollar_usage_metadata,
  feature,
} from '@/db/schema';
import { eq, sum, count, sql, and, gte, lte } from 'drizzle-orm';
import * as z from 'zod';
import { AUTOCOMPLETE_MODEL } from '@/lib/constants';
import { getOrganizationMembers } from '@/lib/organizations/organizations';
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

const UsageDetailsInputSchema = OrganizationIdInputSchema.extend({
  period: TimePeriodSchema.default('month'),
  userFilter: z.enum(['all', 'me']).default('all'),
  groupByModel: z.boolean().default(false),
});

const UsageTimeseriesInputSchema = OrganizationIdInputSchema.extend({
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
});

const UsageTimeseriesOutputSchema = z.object({
  timeseries: z.array(
    z.object({
      datetime: z.string().datetime(),
      name: z.string(),
      email: z.string(),
      model: z.string(),
      provider: z.string(),
      projectId: z.string().nullable(),
      feature: z.string().nullable(),
      costMicrodollars: z.number(),
      inputTokenCount: z.number(),
      outputTokenCount: z.number(),
      requestCount: z.number(),
    })
  ),
});

const UsageDetailsResponseSchema = z.object({
  daily: z.array(
    z.object({
      date: z.string(),
      user: z.object({
        name: z.string(),
        email: z.string(),
      }),
      model: z.string().optional(),
      feature: z.string().optional(),
      microdollarCost: z.string().nullable(),
      tokenCount: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      requestCount: z.number(),
    })
  ),
});

const AutocompleteMetricsOutputSchema = z.object({
  cost: z.number(),
  requests: z.number(),
  tokens: z.number(),
});

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

function daysAgo(days: number): string {
  const now = new Date();
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function getDateThreshold(period: string): string | null {
  switch (period) {
    case 'week':
      return daysAgo(7);
    case 'month':
      return daysAgo(30);
    case 'year':
      return daysAgo(365);
    case 'all':
      return null; // No date filtering for "all"
    default:
      return daysAgo(7); // Default to week
  }
}

export const organizationsUsageDetailsRouter = createTRPCRouter({
  getTimeSeries: organizationMemberProcedure
    .input(UsageTimeseriesInputSchema)
    .output(UsageTimeseriesOutputSchema)
    .query(async ({ input }) => {
      const { organizationId, startDate, endDate } = input;

      // Calculate if range is > 90 days to determine grouping strategy
      const start = new Date(startDate);
      const end = new Date(endDate);
      const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
      const groupByDay = daysDiff > 90;

      // Create the time bucket SQL based on grouping strategy
      const timeBucket = groupByDay
        ? sql<string>`DATE_TRUNC('day', ${microdollar_usage.created_at})`
        : sql<string>`DATE_TRUNC('hour', ${microdollar_usage.created_at})`;

      // First, get the aggregated usage data
      const usageData = await db
        .select({
          datetime: timeBucket.as('datetime'),
          userName: kilocode_users.google_user_name,
          userEmail: kilocode_users.google_user_email,
          model: microdollar_usage.model,
          provider: microdollar_usage.provider,
          projectId: microdollar_usage.project_id,
          feature: feature.feature,
          costMicrodollars: sum(microdollar_usage.cost),
          inputTokenCount: sum(microdollar_usage.input_tokens),
          outputTokenCount: sum(microdollar_usage.output_tokens),
          requestCount: count(microdollar_usage.id),
        })
        .from(microdollar_usage)
        .innerJoin(kilocode_users, eq(kilocode_users.id, microdollar_usage.kilo_user_id))
        .leftJoin(
          microdollar_usage_metadata,
          eq(microdollar_usage.id, microdollar_usage_metadata.id)
        )
        .leftJoin(feature, eq(microdollar_usage_metadata.feature_id, feature.feature_id))
        .where(
          and(
            eq(microdollar_usage.organization_id, organizationId),
            gte(microdollar_usage.created_at, startDate),
            lte(microdollar_usage.created_at, endDate)
          )
        )
        .groupBy(
          timeBucket,
          kilocode_users.google_user_name,
          kilocode_users.google_user_email,
          microdollar_usage.model,
          microdollar_usage.provider,
          microdollar_usage.project_id,
          feature.feature
        )
        .orderBy(timeBucket);

      // Fill in 0's for missing data
      // TODO surely there's a better way to do this
      // Get all unique combinations of user/model/provider/projectId/feature from the data
      const uniqueCombinations = new Map<
        string,
        {
          name: string;
          email: string;
          model: string;
          provider: string;
          projectId: string | null;
          feature: string | null;
        }
      >();
      usageData.forEach(row => {
        const key = `${row.userEmail}|${row.model}|${row.provider}|${row.projectId || 'null'}|${row.feature || 'null'}`;
        if (!uniqueCombinations.has(key)) {
          uniqueCombinations.set(key, {
            name: row.userName || 'Unknown',
            email: row.userEmail || 'unknown@example.com',
            model: row.model || 'Unknown',
            provider: row.provider || 'Unknown',
            projectId: row.projectId || null,
            feature: row.feature || null,
          });
        }
      });

      // Generate all time buckets
      const allTimeBuckets: Date[] = [];
      const currentBucket = new Date(start);
      const endBucket = new Date(end);

      if (groupByDay) {
        currentBucket.setUTCHours(0, 0, 0, 0);
        endBucket.setUTCHours(0, 0, 0, 0);
      } else {
        currentBucket.setUTCMinutes(0, 0, 0);
        endBucket.setUTCMinutes(0, 0, 0);
      }

      while (currentBucket <= endBucket) {
        allTimeBuckets.push(new Date(currentBucket));
        if (groupByDay) {
          currentBucket.setUTCDate(currentBucket.getUTCDate() + 1);
        } else {
          currentBucket.setUTCHours(currentBucket.getUTCHours() + 1);
        }
      }

      // Create a map of existing data for quick lookup
      const dataMap = new Map<string, (typeof usageData)[0]>();
      usageData.forEach(row => {
        const key = `${new Date(row.datetime).toISOString()}|${row.userEmail}|${row.model}|${row.provider}|${row.projectId || 'null'}|${row.feature || 'null'}`;
        dataMap.set(key, row);
      });

      // Generate complete timeseries with zeros for missing data
      const timeseries: Array<{
        datetime: string;
        name: string;
        email: string;
        model: string;
        provider: string;
        projectId: string | null;
        feature: string | null;
        costMicrodollars: number;
        inputTokenCount: number;
        outputTokenCount: number;
        requestCount: number;
      }> = [];

      allTimeBuckets.forEach(bucket => {
        const bucketISO = bucket.toISOString();
        uniqueCombinations.forEach(combo => {
          const key = `${bucketISO}|${combo.email}|${combo.model}|${combo.provider}|${combo.projectId || 'null'}|${combo.feature || 'null'}`;
          const existingData = dataMap.get(key);

          timeseries.push({
            datetime: bucketISO,
            name: combo.name,
            email: combo.email,
            model: combo.model,
            provider: combo.provider,
            projectId: combo.projectId,
            feature: combo.feature,
            costMicrodollars: existingData
              ? Number.parseInt(existingData.costMicrodollars?.toString() || '0')
              : 0,
            inputTokenCount: existingData ? Number(existingData.inputTokenCount) || 0 : 0,
            outputTokenCount: existingData ? Number(existingData.outputTokenCount) || 0 : 0,
            requestCount: existingData ? Number(existingData.requestCount) || 0 : 0,
          });
        });
      });

      return { timeseries };
    }),
  get: organizationMemberProcedure
    .input(UsageDetailsInputSchema)
    .output(UsageDetailsResponseSchema)
    .query(async ({ input, ctx }): Promise<UsageDetails> => {
      const { organizationId, period, userFilter, groupByModel } = input;

      const dateThreshold = getDateThreshold(period);

      const whereConditions = [eq(microdollar_usage.organization_id, organizationId)];
      if (dateThreshold) {
        whereConditions.push(gte(microdollar_usage.created_at, dateThreshold));
      }

      // Add user filter if "me" is selected
      if (userFilter === 'me') {
        whereConditions.push(eq(microdollar_usage.kilo_user_id, ctx.user.id));
      }

      const usageDetails = await db
        .select({
          date: sql<string>`DATE(${microdollar_usage.created_at})`.as('date'),
          userName: kilocode_users.google_user_name,
          userEmail: kilocode_users.google_user_email,
          ...(groupByModel && { model: microdollar_usage.model }),
          feature: feature.feature,
          microdollarCost: sum(microdollar_usage.cost),
          tokenCount: sum(
            sql`${microdollar_usage.input_tokens} + ${microdollar_usage.output_tokens} + ${microdollar_usage.cache_write_tokens} + ${microdollar_usage.cache_hit_tokens}`
          ),
          inputTokens: sum(microdollar_usage.input_tokens),
          outputTokens: sum(microdollar_usage.output_tokens),
          requestCount: count(microdollar_usage.id),
        })
        .from(microdollar_usage)
        .innerJoin(kilocode_users, eq(kilocode_users.id, microdollar_usage.kilo_user_id))
        .leftJoin(
          microdollar_usage_metadata,
          eq(microdollar_usage.id, microdollar_usage_metadata.id)
        )
        .leftJoin(feature, eq(microdollar_usage_metadata.feature_id, feature.feature_id))
        .where(and(...whereConditions))
        .groupBy(
          sql`DATE(${microdollar_usage.created_at})`,
          kilocode_users.google_user_name,
          kilocode_users.google_user_email,
          ...(groupByModel ? [microdollar_usage.model] : []),
          feature.feature
        )
        .orderBy(sql`DATE(${microdollar_usage.created_at}) DESC`);

      const daily = usageDetails.map(row => ({
        date: row.date,
        user: {
          name: row.userName,
          email: row.userEmail,
        },
        ...(groupByModel && { model: 'model' in row ? row.model || undefined : undefined }),
        feature: row.feature || undefined,
        microdollarCost: row.microdollarCost?.toString() || null,
        tokenCount: Number(row.tokenCount) || 0,
        inputTokens: Number(row.inputTokens) || 0,
        outputTokens: Number(row.outputTokens) || 0,
        requestCount: Number(row.requestCount) || 0,
      }));

      return {
        daily,
      };
    }),
  getAutocomplete: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(AutocompleteMetricsOutputSchema)
    .query(async ({ input }) => {
      const { organizationId } = input;

      const result = await db
        .select({
          total_cost: sql<number>`COALESCE(SUM(${microdollar_usage.cost}), 0)::float`,
          request_count: sql<number>`COUNT(*)::float`,
          total_tokens: sql<number>`COALESCE(SUM(${microdollar_usage.input_tokens}) + SUM(${microdollar_usage.output_tokens}), 0)::float`,
        })
        .from(microdollar_usage)
        .where(
          and(
            eq(microdollar_usage.organization_id, organizationId),
            eq(microdollar_usage.model, AUTOCOMPLETE_MODEL)
          )
        );

      const metrics = result[0] || { total_cost: 0, request_count: 0, total_tokens: 0 };

      return {
        cost: metrics.total_cost,
        requests: metrics.request_count,
        tokens: metrics.total_tokens,
      };
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
