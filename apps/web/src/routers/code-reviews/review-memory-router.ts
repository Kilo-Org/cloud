import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import { createTRPCRouter, baseProcedure, type TRPCContext } from '@/lib/trpc/init';
import { runReviewMemoryAnalysis } from '@/lib/code-reviews/review-memory/aggregation';
import {
  countActiveProposals,
  listProposals,
  listRepositoriesWithRecentFeedback,
  rejectProposal,
  updateProposal,
  type ReviewMemoryOwner,
} from '@/lib/code-reviews/review-memory/db';
import {
  getReviewMemoryEnabledFromConfig,
  isReviewMemoryEnabled,
  setReviewMemoryEnabled,
} from '@/lib/code-reviews/review-memory/settings';
import {
  approveAndOpenReviewMemoryChangeRequest,
  ReviewMemoryChangeRequestError,
} from '@/lib/code-reviews/review-memory/change-request';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { REVIEW_MEMORY_PROPOSAL_STATUSES } from '@kilocode/db/schema-types';

const OwnerInputSchema = z.object({ organizationId: z.uuid().optional() });
const PlatformOwnerInputSchema = OwnerInputSchema.extend({ platform: z.enum(['github']) });
const ProposalStatusSchema = z.enum(REVIEW_MEMORY_PROPOSAL_STATUSES);

async function ownerFromInput(
  ctx: TRPCContext,
  input: { organizationId?: string },
  roles?: OrganizationRole[]
): Promise<ReviewMemoryOwner> {
  if (input.organizationId) {
    await ensureOrganizationAccess(ctx, input.organizationId, roles);
    return { type: 'org', id: input.organizationId };
  }
  return { type: 'user', id: ctx.user.id };
}

async function assertEnabled(owner: ReviewMemoryOwner, platform: 'github') {
  if (!(await isReviewMemoryEnabled({ owner, platform }))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Review memory is disabled for this platform.',
    });
  }
}

export const reviewMemoryRouter = createTRPCRouter({
  getDashboardSummary: baseProcedure
    .input(PlatformOwnerInputSchema)
    .query(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      const config = await getAgentConfigForOwner(owner, 'code_review', input.platform);
      const enabled = getReviewMemoryEnabledFromConfig(config?.config);
      const [repositories, openProposalCount] = await Promise.all([
        listRepositoriesWithRecentFeedback({ owner, platform: input.platform }),
        countActiveProposals({ owner, platform: input.platform }),
      ]);
      return { enabled, repositories, openProposalCount };
    }),

  listProposals: baseProcedure
    .input(
      PlatformOwnerInputSchema.extend({
        repoFullName: z.string().min(1).optional(),
        statuses: z.array(ProposalStatusSchema).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      return await listProposals({
        owner,
        platform: input.platform,
        repoFullName: input.repoFullName,
        statuses: input.statuses,
        limit: input.limit,
      });
    }),

  setEnabled: baseProcedure
    .input(PlatformOwnerInputSchema.extend({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ['owner', 'billing_manager']);
      const enabled = await setReviewMemoryEnabled({
        owner,
        platform: input.platform,
        enabled: input.enabled,
        createdBy: ctx.user.id,
      });
      return { enabled };
    }),

  triggerAnalysis: baseProcedure
    .input(PlatformOwnerInputSchema.extend({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ['owner', 'billing_manager']);
      await assertEnabled(owner, input.platform);
      return await runReviewMemoryAnalysis({
        owner,
        platform: input.platform,
        repoFullName: input.repoFullName,
      });
    }),

  updateProposal: baseProcedure
    .input(
      OwnerInputSchema.extend({
        platform: z.enum(['github']),
        proposalId: z.uuid(),
        title: z.string().min(1).max(140),
        rationale: z.string().min(1).max(1_500),
        proposedMarkdown: z.string().min(1).max(4_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ['owner', 'billing_manager']);
      await assertEnabled(owner, input.platform);
      const proposal = await updateProposal({
        owner,
        proposalId: input.proposalId,
        title: input.title,
        rationale: input.rationale,
        proposedMarkdown: input.proposedMarkdown,
      });
      if (!proposal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found.' });
      return proposal;
    }),

  rejectProposal: baseProcedure
    .input(PlatformOwnerInputSchema.extend({ proposalId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ['owner', 'billing_manager']);
      await assertEnabled(owner, input.platform);
      const proposal = await rejectProposal({ owner, proposalId: input.proposalId });
      if (!proposal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found.' });
      return proposal;
    }),

  approveAndOpenChangeRequest: baseProcedure
    .input(PlatformOwnerInputSchema.extend({ proposalId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ['owner', 'billing_manager']);
      await assertEnabled(owner, input.platform);
      try {
        return await approveAndOpenReviewMemoryChangeRequest({
          owner,
          proposalId: input.proposalId,
        });
      } catch (error) {
        if (error instanceof ReviewMemoryChangeRequestError) {
          throw new TRPCError({ code: error.code, message: error.message });
        }
        throw error;
      }
    }),
});
