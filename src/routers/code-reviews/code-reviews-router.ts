/**
 * Code Reviews tRPC Router
 *
 * API endpoints for managing cloud agent code reviews.
 * Supports both organization and personal user code reviews.
 */

import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import {
  organizationMemberProcedure,
  ensureOrganizationAccess,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import { successResult, failureResult } from '@/lib/maybe-result';
import * as z from 'zod';
import {
  listCodeReviews,
  countCodeReviews,
  getCodeReviewById,
  cancelCodeReview,
  resetCodeReviewForRetry,
} from '@/lib/code-reviews/db/code-reviews';
import {
  ListCodeReviewsInputSchema,
  ListCodeReviewsForUserInputSchema,
  GetCodeReviewInputSchema,
  CancelCodeReviewInputSchema,
  RetriggerCodeReviewInputSchema,
  type Owner,
  type ListCodeReviewsResponse,
} from '@/lib/code-reviews/core';
import { DEFAULT_LIST_LIMIT } from '@/lib/code-reviews/core/constants';
import { codeReviewWorkerClient } from '@/lib/code-reviews/client/code-review-worker-client';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';

export const codeReviewRouter = createTRPCRouter({
  /**
   * List code reviews for an organization
   * Requires organization membership
   */
  listForOrganization: organizationMemberProcedure
    .input(ListCodeReviewsInputSchema.omit({ organizationId: true }))
    .query(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationMemberProcedure's input
        // TypeScript doesn't know about it due to .omit(), but it exists at runtime
        const fullInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: fullInput.organizationId,
          userId: ctx.user.id,
        };

        const limit = fullInput.limit ?? DEFAULT_LIST_LIMIT;
        const offset = fullInput.offset ?? 0;

        const [reviews, total] = await Promise.all([
          listCodeReviews({
            owner,
            limit,
            offset,
            status: fullInput.status,
            repoFullName: fullInput.repoFullName,
            platform: fullInput.platform,
          }),
          countCodeReviews({
            owner,
            status: fullInput.status,
            repoFullName: fullInput.repoFullName,
            platform: fullInput.platform,
          }),
        ]);

        const response: ListCodeReviewsResponse = {
          reviews,
          total,
          hasMore: offset + reviews.length < total,
        };

        return successResult(response);
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to list code reviews'
        );
      }
    }),

  /**
   * List code reviews for the current user (personal)
   */
  listForUser: baseProcedure
    .input(ListCodeReviewsForUserInputSchema)
    .query(async ({ input, ctx }) => {
      try {
        const owner: Owner = {
          type: 'user',
          id: ctx.user.id,
          userId: ctx.user.id,
        };

        const limit = input.limit ?? DEFAULT_LIST_LIMIT;
        const offset = input.offset ?? 0;

        const [reviews, total] = await Promise.all([
          listCodeReviews({
            owner,
            limit,
            offset,
            status: input.status,
            repoFullName: input.repoFullName,
            platform: input.platform,
          }),
          countCodeReviews({
            owner,
            status: input.status,
            repoFullName: input.repoFullName,
            platform: input.platform,
          }),
        ]);

        const response: ListCodeReviewsResponse = {
          reviews,
          total,
          hasMore: offset + reviews.length < total,
        };

        return successResult(response);
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to list code reviews'
        );
      }
    }),

  /**
   * Get a specific code review by ID
   * Verifies user ownership
   */
  get: baseProcedure.input(GetCodeReviewInputSchema).query(async ({ input, ctx }) => {
    try {
      const review = await getCodeReviewById(input.reviewId);

      if (!review) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Code review not found',
        });
      }

      // Authorization check based on owner type
      if (review.owned_by_organization_id) {
        // Organization review: verify user is org member
        await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
      } else if (review.owned_by_user_id) {
        // Personal review: verify user owns it
        if (review.owned_by_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this code review',
          });
        }
      } else {
        // Should not happen, but handle edge case
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid review ownership data',
        });
      }

      return successResult({ review });
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      return failureResult(error instanceof Error ? error.message : 'Failed to get code review');
    }
  }),

  /**
   * Cancel a code review
   * For running/queued reviews: calls the worker to stop execution and interrupt the cloud agent session
   * For pending reviews: just updates DB status (not dispatched to worker yet)
   */
  cancel: baseProcedure.input(CancelCodeReviewInputSchema).mutation(async ({ input, ctx }) => {
    try {
      const review = await getCodeReviewById(input.reviewId);

      if (!review) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Code review not found',
        });
      }

      // Authorization check based on owner type
      if (review.owned_by_organization_id) {
        // Organization review: verify user is org member
        await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
      } else if (review.owned_by_user_id) {
        // Personal review: verify user owns it
        if (review.owned_by_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this code review',
          });
        }
      } else {
        // Should not happen, but handle edge case
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid review ownership data',
        });
      }

      // Don't allow cancelling already completed/failed/cancelled/interrupted reviews
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(review.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot cancel a review that is already ${review.status}`,
        });
      }

      // For running or queued reviews, call the worker to trigger full interrupt chain
      // This will: stop stream processing, update DB, and interrupt cloud agent session (kill processes)
      if (['running', 'queued'].includes(review.status)) {
        try {
          await codeReviewWorkerClient.cancelReview(input.reviewId, 'Cancelled by user');
          // Worker updates DB status and interrupts cloud agent session
          return successResult({ message: 'Code review cancelled successfully' });
        } catch (workerError) {
          // If worker call fails, still update DB status as fallback
          console.error('Worker cancel failed, updating DB directly:', workerError);
          await cancelCodeReview(input.reviewId);
          return successResult({ message: 'Code review cancelled (worker unreachable)' });
        }
      }

      // For pending reviews (not yet dispatched to worker), just update DB
      await cancelCodeReview(input.reviewId);

      return successResult({ message: 'Code review cancelled successfully' });
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      return failureResult(error instanceof Error ? error.message : 'Failed to cancel code review');
    }
  }),

  /**
   * Retrigger a failed, cancelled, or interrupted code review
   * Resets status to 'pending' and dispatches for processing
   */
  retrigger: baseProcedure
    .input(RetriggerCodeReviewInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const review = await getCodeReviewById(input.reviewId);

        if (!review) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Code review not found',
          });
        }

        // Authorization check based on owner type
        if (review.owned_by_organization_id) {
          // Organization review: verify user is org member
          await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
        } else if (review.owned_by_user_id) {
          // Personal review: verify user owns it
          if (review.owned_by_user_id !== ctx.user.id) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not have access to this code review',
            });
          }
        } else {
          // Should not happen, but handle edge case
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Invalid review ownership data',
          });
        }

        // Allow retriggering failed, cancelled, and interrupted reviews
        const retriggableStatuses = ['failed', 'cancelled', 'interrupted'];
        if (!retriggableStatuses.includes(review.status)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cannot retrigger a review that is ${review.status}. Only failed, cancelled, or interrupted reviews can be retriggered.`,
          });
        }

        // Reset the review for retry
        await resetCodeReviewForRetry(input.reviewId);

        // Build owner object for dispatch
        const owner: Owner = review.owned_by_organization_id
          ? { type: 'org', id: review.owned_by_organization_id, userId: ctx.user.id }
          : { type: 'user', id: review.owned_by_user_id as string, userId: ctx.user.id };

        // Try to dispatch the review
        await tryDispatchPendingReviews(owner);

        return successResult({ message: 'Code review retriggered successfully' });
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        return failureResult(
          error instanceof Error ? error.message : 'Failed to retrigger code review'
        );
      }
    }),

  /**
   * Get events for a code review (for streaming)
   * Verifies user has access to the review:
   * - For org reviews: user must be org member
   * - For personal reviews: user must be the owner
   */
  getReviewEvents: baseProcedure
    .input(
      z.object({
        reviewId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        // Get the review from database
        const review = await getCodeReviewById(input.reviewId);

        if (!review) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Code review not found',
          });
        }

        // Authorization check based on owner type
        if (review.owned_by_organization_id) {
          // Organization review: verify user is org member
          await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
        } else if (review.owned_by_user_id) {
          // Personal review: verify user owns it
          if (review.owned_by_user_id !== ctx.user.id) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not have access to this code review',
            });
          }
        } else {
          // Should not happen, but handle edge case
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Invalid review ownership data',
          });
        }

        // Fetch events from worker (server-side, auth token stays secure)
        const events = await codeReviewWorkerClient.getReviewEvents(input.reviewId);

        return successResult({ events });
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        return failureResult(
          error instanceof Error ? error.message : 'Failed to fetch review events'
        );
      }
    }),
});
