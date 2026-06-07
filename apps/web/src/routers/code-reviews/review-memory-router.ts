import { createTRPCRouter, baseProcedure, type TRPCContext } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { dispatchManualReviewMemoryAggregation } from '@/lib/code-reviews/review-memory/aggregation';
import {
  approveAndOpenReviewMemoryChangeRequest,
  ReviewMemoryChangeRequestError,
} from '@/lib/code-reviews/review-memory/change-request';
import {
  countActionableProposals,
  getReviewMemoryProposal,
  listAggregationStates,
  listReviewMemoryProposals,
  listReviewMemoryRepositories,
  refreshAggregationStateForScope,
  rejectReviewMemoryProposal,
  updateReviewMemoryProposal,
  type ReviewMemoryOwner,
} from '@/lib/code-reviews/review-memory/db';
import {
  isReviewMemoryEnabled,
  setReviewMemoryEnabled,
} from '@/lib/code-reviews/review-memory/settings';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

const ReviewMemoryPlatformSchema = z.enum(['github', 'gitlab']);
const ReviewMemoryProposalStatusSchema = z.enum([
  'open',
  'edited',
  'approved',
  'opening_change_request',
  'change_request_opened',
  'change_request_failed',
  'rejected',
  'superseded',
]);
const ReviewMemoryProposalTypeSchema = z.enum(['suppress', 'clarify', 'narrow', 'reinforce']);
const ReviewMemoryProposalScopeKindSchema = z.enum(['repository', 'path_glob', 'file', 'language']);

const OwnerInputSchema = z.object({
  organizationId: z.uuid().optional(),
});

const PlatformOwnerInputSchema = OwnerInputSchema.extend({
  platform: ReviewMemoryPlatformSchema,
});

async function ownerFromInput(
  ctx: TRPCContext,
  input: z.infer<typeof OwnerInputSchema>,
  organizationRoles?: OrganizationRole[]
): Promise<ReviewMemoryOwner> {
  if (input.organizationId) {
    await ensureOrganizationAccess(ctx, input.organizationId, organizationRoles);
    return { type: 'org', id: input.organizationId };
  }

  return { type: 'user', id: ctx.user.id };
}

async function assertReviewMemoryEnabled(input: {
  owner: ReviewMemoryOwner;
  platform: z.infer<typeof ReviewMemoryPlatformSchema>;
}) {
  const enabled = await isReviewMemoryEnabled(input);
  if (!enabled) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Review memory is disabled for this platform.',
    });
  }
}

export const reviewMemoryRouter = createTRPCRouter({
  getDashboardSummary: baseProcedure
    .input(
      PlatformOwnerInputSchema.extend({
        repoFullName: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      const [enabled, repositories, states, actionableProposalCount] = await Promise.all([
        isReviewMemoryEnabled({ owner, platform: input.platform }),
        listReviewMemoryRepositories({ owner, platform: input.platform }),
        listAggregationStates({
          owner,
          platform: input.platform,
          repoFullName: input.repoFullName,
        }),
        countActionableProposals({
          owner,
          platform: input.platform,
          repoFullName: input.repoFullName,
        }),
      ]);

      return {
        enabled,
        repositories: input.repoFullName
          ? repositories.filter(repository => repository.repoFullName === input.repoFullName)
          : repositories,
        states,
        actionableProposalCount,
      };
    }),

  setEnabled: baseProcedure
    .input(PlatformOwnerInputSchema.extend({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ['owner', 'billing_manager']);
      if (input.organizationId) {
        await requireActiveSubscriptionOrTrial(input.organizationId);
      }

      const enabled = await setReviewMemoryEnabled({
        owner,
        platform: input.platform,
        enabled: input.enabled,
        createdBy: ctx.user.id,
      });

      return { success: true, enabled };
    }),

  listProposals: baseProcedure
    .input(
      PlatformOwnerInputSchema.extend({
        repoFullName: z.string().optional(),
        statuses: z.array(ReviewMemoryProposalStatusSchema).optional(),
        proposalType: ReviewMemoryProposalTypeSchema.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      return await listReviewMemoryProposals({
        owner,
        platform: input.platform,
        repoFullName: input.repoFullName,
        statuses: input.statuses,
        proposalType: input.proposalType,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  getProposal: baseProcedure
    .input(OwnerInputSchema.extend({ proposalId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      const proposal = await getReviewMemoryProposal({ owner, proposalId: input.proposalId });
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Review memory proposal not found' });
      }

      return { proposal, evidence: [] };
    }),

  updateProposal: baseProcedure
    .input(
      OwnerInputSchema.extend({
        proposalId: z.uuid(),
        title: z.string().min(1).max(140),
        rationale: z.string().min(1).max(1_500),
        proposedMarkdown: z.string().min(1).max(4_000),
        scopeKind: ReviewMemoryProposalScopeKindSchema,
        scopeValue: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      const existingProposal = await getReviewMemoryProposal({
        owner,
        proposalId: input.proposalId,
      });
      if (!existingProposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Review memory proposal not found' });
      }
      await assertReviewMemoryEnabled({ owner, platform: existingProposal.platform });
      const proposal = await updateReviewMemoryProposal({
        owner,
        proposalId: input.proposalId,
        title: input.title,
        rationale: input.rationale,
        proposedMarkdown: input.proposedMarkdown,
        scopeKind: input.scopeKind,
        scopeValue: input.scopeValue,
      });
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Review memory proposal not found' });
      }
      return proposal;
    }),

  rejectProposal: baseProcedure
    .input(OwnerInputSchema.extend({ proposalId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      const existingProposal = await getReviewMemoryProposal({
        owner,
        proposalId: input.proposalId,
      });
      if (!existingProposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Review memory proposal not found' });
      }
      await assertReviewMemoryEnabled({ owner, platform: existingProposal.platform });
      const proposal = await rejectReviewMemoryProposal({
        owner,
        proposalId: input.proposalId,
      });
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Review memory proposal not found' });
      }
      return proposal;
    }),

  approveAndOpenChangeRequest: baseProcedure
    .input(OwnerInputSchema.extend({ proposalId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ['owner']);
      const proposal = await getReviewMemoryProposal({ owner, proposalId: input.proposalId });
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Review memory proposal not found' });
      }
      await assertReviewMemoryEnabled({ owner, platform: proposal.platform });
      try {
        return await approveAndOpenReviewMemoryChangeRequest({
          owner,
          proposalId: input.proposalId,
          approvedByUser: {
            id: ctx.user.id,
            email: ctx.user.google_user_email,
            name: ctx.user.google_user_name,
          },
        });
      } catch (error) {
        if (error instanceof ReviewMemoryChangeRequestError) {
          throw new TRPCError({ code: error.code, message: error.message });
        }
        throw error;
      }
    }),

  triggerAnalysis: baseProcedure
    .input(
      PlatformOwnerInputSchema.extend({
        repoFullName: z.string().min(1),
        platformProjectId: z.number().int().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      await assertReviewMemoryEnabled({ owner, platform: input.platform });
      const state = await refreshAggregationStateForScope({
        owner,
        platform: input.platform,
        repoFullName: input.repoFullName,
        platformProjectId: input.platformProjectId,
      });
      const summary = await dispatchManualReviewMemoryAggregation({
        limit: 1,
        stateId: state.id,
        bypassEligibleCooldown: true,
      });
      const refreshedState = await refreshAggregationStateForScope({
        owner,
        platform: input.platform,
        repoFullName: input.repoFullName,
        platformProjectId: input.platformProjectId,
      });
      return { state: refreshedState, summary };
    }),
});
