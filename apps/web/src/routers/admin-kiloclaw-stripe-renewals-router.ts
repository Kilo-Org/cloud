import { superadminProcedure } from '@/lib/trpc/admin-procedures';
import {
  createStripeRenewalBatchPreview,
  getStripeRenewalBatchStatus,
  retryStripeRenewalBatch,
  startStripeRenewalBatch,
} from '@/lib/kiloclaw/admin-stripe-renewal-batch';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

function actor(user: { id: string; google_user_email: string; google_user_name: string | null }) {
  return { id: user.id, email: user.google_user_email, name: user.google_user_name };
}

export const adminKiloclawStripeRenewalsRouter = createTRPCRouter({
  preview: superadminProcedure.mutation(({ ctx }) =>
    createStripeRenewalBatchPreview(actor(ctx.user))
  ),
  start: superadminProcedure
    .input(
      z.object({
        previewId: z.string().uuid(),
        confirmation: z.literal('STOP STRIPE RENEWALS'),
        reason: z.string().min(1).max(500),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await startStripeRenewalBatch({
          previewId: input.previewId,
          actor: actor(ctx.user),
          reason: input.reason,
        });
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Unable to start renewal batch',
        });
      }
    }),
  status: superadminProcedure.query(() => getStripeRenewalBatchStatus()),
  retry: superadminProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await retryStripeRenewalBatch(input.runId, actor(ctx.user));
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Unable to retry renewal batch',
        });
      }
    }),
});
