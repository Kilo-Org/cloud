import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import type { CodeReviewMemoryProposal } from '@kilocode/db/schema';
import {
  createTRPCRouter,
  baseProcedure,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { runReviewMemoryAnalysis } from '@/lib/code-reviews/review-memory/aggregation';
import {
  countActiveProposals,
  listProposals,
  listProposalsPage,
  listRepositoriesWithRecentFeedback,
  rejectProposal,
  ReviewMemoryProposalConflictError,
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
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY } from '@kilocode/app-shared/code-reviews';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
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
      message: REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.review_memory_disabled,
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

  // Compatibility: `listProposals` above keeps the deployed array shape for
  // the web panel and stale client bundles. The paginated shape is additive.
  listProposalsPage: baseProcedure
    .input(
      PlatformOwnerInputSchema.extend({
        repoFullName: z.string().min(1).optional(),
        statuses: z.array(ProposalStatusSchema).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input);
      return await listProposalsPage({
        owner,
        platform: input.platform,
        repoFullName: input.repoFullName,
        statuses: input.statuses,
        limit: input.limit,
        cursor: input.cursor,
      });
    }),

  setEnabled: baseProcedure
    .input(PlatformOwnerInputSchema.extend({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ORGANIZATION_BILLING_ROLES);
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
      const owner = await ownerFromInput(ctx, input, ORGANIZATION_BILLING_ROLES);
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
      const owner = await ownerFromInput(ctx, input, ORGANIZATION_BILLING_ROLES);
      await assertEnabled(owner, input.platform);
      let proposal: CodeReviewMemoryProposal | null;
      try {
        proposal = await updateProposal({
          owner,
          proposalId: input.proposalId,
          title: input.title,
          rationale: input.rationale,
          proposedMarkdown: input.proposedMarkdown,
        });
      } catch (error) {
        if (error instanceof ReviewMemoryProposalConflictError) {
          throw new TRPCError({ code: 'CONFLICT', message: error.message });
        }
        throw error;
      }
      if (!proposal) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.proposal_not_found,
        });
      }
      return proposal;
    }),

  rejectProposal: baseProcedure
    .input(PlatformOwnerInputSchema.extend({ proposalId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ORGANIZATION_BILLING_ROLES);
      await assertEnabled(owner, input.platform);
      const proposal = await rejectProposal({ owner, proposalId: input.proposalId });
      if (!proposal) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.proposal_not_found,
        });
      }
      return proposal;
    }),

  approveAndOpenChangeRequest: baseProcedure
    .input(PlatformOwnerInputSchema.extend({ proposalId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await ownerFromInput(ctx, input, ORGANIZATION_BILLING_ROLES);
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
