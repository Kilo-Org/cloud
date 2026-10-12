import 'server-only';

import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { isFeedbackRateLimitError, submitUserFeedback } from '@/lib/feedback/submit';
import * as z from 'zod';

const CreateUserFeedbackInputSchema = z.object({
  feedback_text: z.string().optional().default(''),
  feedback_for: z.string().min(1).default(FeedbackFor.Unknown),
  feedback_batch: z.string().min(1).optional(),
  source: z.string().min(1).default(FeedbackSource.Web),
  context_json: z.record(z.string(), z.unknown()).default({}),
});

export const userFeedbackRouter = createTRPCRouter({
  create: baseProcedure.input(CreateUserFeedbackInputSchema).mutation(async ({ ctx, input }) => {
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
