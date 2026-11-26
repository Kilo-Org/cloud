import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { creditManagerProcedure } from '@/lib/trpc/admin-procedures';
import {
  addAdminAuditMetadata,
  inputFieldTarget,
  setAdminAuditTarget,
  userActionTarget,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import {
  enrollContributorChampion,
  getContributorChampionLeaderboard,
  getContributorChampionReviewQueue,
  getContributorContributionDrillIn,
  getEnrolledContributorChampions,
  manualEnrollContributor,
  searchKiloUsersByEmail,
  syncContributorChampionData,
  upgradeContributorChampionTier,
  upsertContributorSelectedTier,
} from '@/lib/contributor-champions/service';
import * as z from 'zod';

const TierSchema = z.enum(['contributor', 'ambassador', 'champion']);

export const contributorChampionsRouter = createTRPCRouter({
  syncNow: adminProcedure
    .meta({ adminAudit: { kind: 'declarative', action: 'contributor_champion.sync' } })
    .mutation(async () => {
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
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'contributor_champion.tier.select',
        target: inputFieldTarget('other', 'contributorId'),
      },
    })
    .input(
      z.object({
        contributorId: z.string().uuid(),
        selectedTier: TierSchema,
      })
    )
    .mutation(async ({ input }) => {
      addAdminAuditMetadata({ selectedTier: input.selectedTier });
      await upsertContributorSelectedTier(input);
      return { success: true };
    }),

  enroll: creditManagerProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'contributor_champion.enroll',
        target: inputFieldTarget('other', 'contributorId'),
      },
    })
    .input(
      z.object({
        contributorId: z.string().uuid(),
        tier: TierSchema.nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const result = await enrollContributorChampion({
        contributorId: input.contributorId,
        tier: input.tier ?? null,
      });
      if (result.creditedKiloUserId) {
        setAdminAuditTarget(userActionTarget(result.creditedKiloUserId));
      }
      addAdminAuditMetadata({
        contributorId: input.contributorId,
        enrolledTier: result.enrolledTier,
        creditAmountUsd: result.creditAmountUsd,
        creditGranted: result.creditGranted,
      });
      return {
        success: true,
        enrolledTier: result.enrolledTier,
        creditAmountUsd: result.creditAmountUsd,
        creditGranted: result.creditGranted,
      };
    }),

  upgradeTier: creditManagerProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'contributor_champion.tier.upgrade',
        target: inputFieldTarget('other', 'contributorId'),
      },
    })
    .input(
      z.object({
        contributorId: z.string().uuid(),
        newTier: TierSchema,
      })
    )
    .mutation(async ({ input }) => {
      const result = await upgradeContributorChampionTier({
        contributorId: input.contributorId,
        newTier: input.newTier,
      });
      if (result.creditedKiloUserId) {
        setAdminAuditTarget(userActionTarget(result.creditedKiloUserId));
      }
      addAdminAuditMetadata({
        contributorId: input.contributorId,
        upgradedTier: result.upgradedTier,
        creditGrantedUsd: result.creditGrantedUsd,
        creditPendingUsd: result.creditPendingUsd,
      });
      return {
        success: true,
        upgradedTier: result.upgradedTier,
        creditGrantedUsd: result.creditGrantedUsd,
        creditPendingUsd: result.creditPendingUsd,
      };
    }),

  enrolledList: adminProcedure.query(async () => {
    return getEnrolledContributorChampions();
  }),

  searchKiloUsers: adminProcedure
    .input(z.object({ query: z.string().min(2).max(100) }))
    .query(async ({ input }) => {
      return searchKiloUsersByEmail(input.query);
    }),

  manualEnroll: creditManagerProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'contributor_champion.manual_enroll',
        target: inputFieldTarget('user', 'kiloUserId'),
      },
    })
    .input(
      z.object({
        email: z.string().email(),
        githubLogin: z.string().nullable(),
        tier: TierSchema,
        kiloUserId: z.string().uuid().nullable(),
      })
    )
    .mutation(async ({ input }) => {
      const result = await manualEnrollContributor(input);
      addAdminAuditMetadata({
        enrolledTier: result.enrolledTier,
        creditAmountUsd: result.creditAmountUsd,
        creditGranted: result.creditGranted,
      });
      return {
        success: true,
        enrolledTier: result.enrolledTier,
        creditAmountUsd: result.creditAmountUsd,
        creditGranted: result.creditGranted,
      };
    }),
});
