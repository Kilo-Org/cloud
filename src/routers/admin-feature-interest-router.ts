import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { posthogQuery } from '@/lib/posthog-query';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

// Types for feature interest data
export type FeatureInterestLeaderboard = {
  feature: string;
  unique_signups: number;
  total_signups: number;
};

export type FeatureSlugLeaderboard = {
  feature_slug: string;
  unique_signups: number;
  total_signups: number;
};

export type FeatureInterestTimelineEntry = {
  week_start: string;
  feature: string;
  signups: number;
};

export type FeatureSignupUser = {
  email: string;
  name: string;
  company: string | null;
  role: string | null;
  signed_up_at: string;
};

// Input schemas
const TimelineInputSchema = z.object({
  weeks: z.number().min(1).max(52).default(12),
});

const DetailInputSchema = z.object({
  slug: z.string(),
  name: z.string().nullish(),
  limit: z.number().min(1).max(10000).default(10000),
  offset: z.number().min(0).default(0),
});

export const adminFeatureInterestRouter = createTRPCRouter({
  // Feature Interest Leaderboard
  list: adminProcedure.query(async () => {
    // Query 1: Feature Interest Leaderboard - aggregated counts per feature
    // Match events containing 'early' or 'beta' to include all signup sources
    const leaderboardQuery = `
      SELECT
        replaceAll(arrayJoin(JSONExtractArrayRaw(properties, 'features')), '"', '') as feature,
        count(DISTINCT properties.email) as unique_signups,
        count(*) as total_signups
      FROM events
      WHERE (event LIKE '%early%' OR event LIKE '%beta%')
      GROUP BY feature
      ORDER BY unique_signups DESC
    `;

    // Query 2: Signups by Feature Slug - for single-feature signups
    // Match events containing 'early' or 'beta' to include all signup sources
    const bySlugQuery = `
      SELECT
        properties.feature_slug as feature_slug,
        count(DISTINCT properties.email) as unique_signups,
        count(*) as total_signups
      FROM events
      WHERE (event LIKE '%early%' OR event LIKE '%beta%')
        AND properties.feature_slug IS NOT NULL
      GROUP BY feature_slug
      ORDER BY unique_signups DESC
    `;

    const [leaderboardResult, bySlugResult] = await Promise.all([
      posthogQuery('feature_interest_leaderboard', leaderboardQuery),
      posthogQuery('feature_interest_by_slug', bySlugQuery),
    ]);

    if (leaderboardResult.status === 'error') {
      console.error('PostHog leaderboard query error:', leaderboardResult.error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch feature interest leaderboard',
      });
    }

    if (bySlugResult.status === 'error') {
      console.error('PostHog by-slug query error:', bySlugResult.error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch feature interest by slug',
      });
    }

    const leaderboard: FeatureInterestLeaderboard[] = (leaderboardResult.body.results ?? []).map(
      (row: unknown[]) => ({
        feature: String(row[0] ?? ''),
        unique_signups: Number(row[1] ?? 0),
        total_signups: Number(row[2] ?? 0),
      })
    );

    const bySlug: FeatureSlugLeaderboard[] = (bySlugResult.body.results ?? []).map(
      (row: unknown[]) => ({
        feature_slug: String(row[0] ?? ''),
        unique_signups: Number(row[1] ?? 0),
        total_signups: Number(row[2] ?? 0),
      })
    );

    return { leaderboard, bySlug, leaderboardQuery, bySlugQuery };
  }),

  // Feature Interest Timeline
  timeline: adminProcedure.input(TimelineInputSchema).query(async ({ input }) => {
    const { weeks } = input;

    // Match events containing 'early' or 'beta' to include all signup sources
    const timelineQuery = `
      SELECT
        toStartOfWeek(timestamp, 1) as week_start,
        replaceAll(arrayJoin(JSONExtractArrayRaw(properties, 'features')), '"', '') as feature,
        count(DISTINCT properties.email) as signups
      FROM events
      WHERE (event LIKE '%early%' OR event LIKE '%beta%')
        AND timestamp >= now() - INTERVAL ${weeks} WEEK
      GROUP BY week_start, feature
      ORDER BY week_start, signups DESC
    `;

    const result = await posthogQuery('feature_interest_timeline', timelineQuery);

    if (result.status === 'error') {
      console.error('PostHog timeline query error:', result.error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch feature interest timeline',
      });
    }

    const timeline: FeatureInterestTimelineEntry[] = (result.body.results ?? []).map(
      (row: unknown[]) => ({
        week_start: String(row[0] ?? ''),
        feature: String(row[1] ?? ''),
        signups: Number(row[2] ?? 0),
      })
    );

    return { timeline, query: timelineQuery };
  }),

  // Feature Interest Detail (by slug)
  detail: adminProcedure.input(DetailInputSchema).query(async ({ input }) => {
    const { slug, name: nameParam, limit, offset } = input;

    // When 'name' is provided (from Feature Interest Leaderboard), search by features array
    // When only slug is provided (from Signups by Feature Page), search by feature_slug property
    const featureName = nameParam ?? slug;

    // Escape single quotes in the feature name for the SQL query
    const escapedValue = featureName.replace(/'/g, "\\'");
    const escapedSlug = slug.replace(/'/g, "\\'");

    // Build the WHERE condition based on search type
    // Use LIKE for partial matching to capture all variations of feature names
    const whereCondition = nameParam
      ? `properties.features LIKE '%${escapedValue}%'`
      : `(properties.feature_slug = '${escapedSlug}' OR properties.features LIKE '%${escapedValue}%')`;

    // Query for users interested in a specific feature
    // Match events containing 'early' or 'beta' to include all signup sources
    const usersQuery = `
      SELECT
        properties.email as email,
        properties.name as name,
        properties.company as company,
        properties.role as role,
        timestamp as signed_up_at
      FROM events
      WHERE (event LIKE '%early%' OR event LIKE '%beta%')
        AND ${whereCondition}
      ORDER BY timestamp DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    // Query for total count
    const countQuery = `
      SELECT count(DISTINCT properties.email) as total
      FROM events
      WHERE (event LIKE '%early%' OR event LIKE '%beta%')
        AND ${whereCondition}
    `;

    const [usersResult, countResult] = await Promise.all([
      posthogQuery('feature_interest_users', usersQuery),
      posthogQuery('feature_interest_count', countQuery),
    ]);

    if (usersResult.status === 'error') {
      console.error('PostHog users query error:', usersResult.error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch feature interest users',
      });
    }

    if (countResult.status === 'error') {
      console.error('PostHog count query error:', countResult.error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch feature interest count',
      });
    }

    const users: FeatureSignupUser[] = (usersResult.body.results ?? []).map((row: unknown[]) => ({
      email: String(row[0] ?? ''),
      name: String(row[1] ?? ''),
      company: row[2] ? String(row[2]) : null,
      role: row[3] ? String(row[3]) : null,
      signed_up_at: String(row[4] ?? ''),
    }));

    const total_count = Number((countResult.body.results?.[0] as unknown[])?.[0] ?? 0);

    return {
      feature: featureName,
      users,
      total_count,
      usersQuery,
      countQuery,
    };
  }),
});
