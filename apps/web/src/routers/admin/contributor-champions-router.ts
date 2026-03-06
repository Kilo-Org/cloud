import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  enrollContributorChampion,
  getContributorChampionLeaderboard,
  getContributorChampionReviewQueue,
  getContributorContributionDrillIn,
  getEnrolledContributorChampions,
  manualEnrollContributor,
  searchKiloUsersByEmail,
  syncContributorChampionData,
  upsertContributorSelectedTier,
} from '@/lib/contributor-champions/service';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

const TierSchema = z.enum(['contributor', 'ambassador', 'champion']);

export const contributorChampionsRouter = createTRPCRouter({
  syncNow: adminProcedure.mutation(async () => {
    return syncContributorChampionData();
  }),

  leaderboard: adminProcedure.query(async () => {
    return getContributorChampionLeaderboard();
  }),

  contributionDrillIn: adminProcedure
    .input(
      z.object({
        contributorId: z.string().uuid(),
        window: z.enum(['all_time', 'rolling_30_days']),
      })
    )
    .query(async ({ input }) => {
      return getContributorContributionDrillIn({
        contributorId: input.contributorId,
        window: input.window,
      });
    }),

  reviewQueue: adminProcedure.query(async () => {
    return getContributorChampionReviewQueue();
  }),

  setSelectedTier: adminProcedure
    .input(
      z.object({
        contributorId: z.string().uuid(),
        selectedTier: TierSchema,
      })
    )
    .mutation(async ({ input }) => {
      await upsertContributorSelectedTier(input);
      return { success: true };
    }),

  enroll: adminProcedure
    .input(
      z.object({
        contributorId: z.string().uuid(),
        tier: TierSchema.nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const result = await enrollContributorChampion({
          contributorId: input.contributorId,
          tier: input.tier ?? null,
        });
        return {
          success: true,
          enrolledTier: result.enrolledTier,
          creditAmountUsd: result.creditAmountUsd,
          creditGranted: result.creditGranted,
        };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Failed to enroll contributor',
        });
      }
    }),

  enrolledList: adminProcedure.query(async () => {
    return getEnrolledContributorChampions();
  }),

  searchKiloUsers: adminProcedure
    .input(z.object({ query: z.string().min(2).max(100) }))
    .query(async ({ input }) => {
      return searchKiloUsersByEmail(input.query);
    }),

  manualEnroll: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        githubLogin: z.string().nullable(),
        tier: TierSchema,
        kiloUserId: z.string().uuid().nullable(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const result = await manualEnrollContributor(input);
        return {
          success: true,
          enrolledTier: result.enrolledTier,
          creditAmountUsd: result.creditAmountUsd,
          creditGranted: result.creditGranted,
        };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Failed to manually enroll contributor',
        });
      }
    }),
});
