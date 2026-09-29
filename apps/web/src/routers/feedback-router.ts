import 'server-only';

import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { isFeedbackRateLimitError, submitUserFeedback } from '@/lib/feedback/submit';

/**
 * MCP-facing feedback entry point. `feedback.submit` is the tRPC twin of the
 * HTTP `POST /feedback` route: both authenticate, both funnel into the shared
 * submission service, and both surface the same rate-limit message. An
 * unauthenticated tRPC caller is refused by `createTRPCContext`, which throws
 * `UNAUTHORIZED` before this procedure runs.
 */
const SubmitFeedbackInputSchema = z.object({
  feedback_text: z.string().optional().default(''),
  feedback_for: z.string().min(1).default(FeedbackFor.Unknown),
  feedback_batch: z.string().min(1).optional(),
  source: z.string().min(1).default(FeedbackSource.Web),
  context_json: z.record(z.string(), z.unknown()).default({}),
});

export const feedbackRouter = createTRPCRouter({
  submit: baseProcedure.input(SubmitFeedbackInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await submitUserFeedback({
        userId: ctx.user.id,
        feedbackText: input.feedback_text,
        feedbackFor: input.feedback_for,
        feedbackBatch: input.feedback_batch,
        source: input.source,
        contextJson: input.context_json,
      });
    } catch (error) {
      if (isFeedbackRateLimitError(error)) {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message });
      }
      throw error;
    }
  }),
});
