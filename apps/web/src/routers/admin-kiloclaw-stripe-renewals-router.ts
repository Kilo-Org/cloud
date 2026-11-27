import { superadminProcedure } from '@/lib/trpc/admin-procedures';
import {
  createStripeRenewalBatchPreview,
  getStripeRenewalBatchStatus,
  retryStripeRenewalBatch,
  startStripeRenewalBatch,
  StripeRenewalBatchInputError,
} from '@/lib/kiloclaw/admin-stripe-renewal-batch';
import {
  addAdminAuditMetadata,
  recordAdminActions,
  setAdminAuditTarget,
  userActionTarget,
  type AdminActionContext,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import type { AdminActionAuditAction } from '@kilocode/db/schema-types';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

function actor(user: { id: string; google_user_email: string; google_user_name: string | null }) {
  return { id: user.id, email: user.google_user_email, name: user.google_user_name };
}

/** One admin row per user the batch run affects, or one row naming the run when none. */
async function recordRunUsers(
  ctx: AdminActionContext,
  action: AdminActionAuditAction,
  runId: string,
  userIds: readonly string[],
  message: string
) {
  await recordAdminActions(
    ctx,
    userIds.length > 0
      ? userIds.map(userId => ({
          action,
          target: userActionTarget(userId),
          message,
          metadata: { runId },
        }))
      : [{ action, target: { type: 'other', id: runId }, message: `${message}: no users affected` }]
  );
}

export const adminKiloclawStripeRenewalsRouter = createTRPCRouter({
  preview: superadminProcedure
    .meta({
      adminAudit: { kind: 'declarative', action: 'kiloclaw.subscription.stripe_renewal.preview' },
    })
    .mutation(async ({ ctx }) => {
      const preview = await createStripeRenewalBatchPreview(actor(ctx.user));
      setAdminAuditTarget({ type: 'other', id: preview.id });
      addAdminAuditMetadata({ total: preview.total });
      return preview;
    }),
  start: superadminProcedure
    .meta({
      adminAudit: { kind: 'handler', actions: ['kiloclaw.subscription.stripe_renewal.stop'] },
    })
    .input(
      z.object({
        previewId: z.string().uuid(),
        confirmation: z.literal('STOP STRIPE RENEWALS'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      setAdminAuditTarget({ type: 'other', id: input.previewId });
      let result;
      try {
        result = await startStripeRenewalBatch({
          previewId: input.previewId,
          actor: actor(ctx.user),
        });
      } catch (error) {
        throw new TRPCError({
          code:
            error instanceof StripeRenewalBatchInputError ? error.code : 'INTERNAL_SERVER_ERROR',
          message:
            error instanceof StripeRenewalBatchInputError
              ? error.message
              : 'Unable to start Stripe renewal batch',
          cause: error,
        });
      }
      await recordRunUsers(
        ctx,
        'kiloclaw.subscription.stripe_renewal.stop',
        result.id,
        result.startedUserIds,
        'Started stopping KiloClaw Stripe renewal'
      );
      return { id: result.id };
    }),
  status: superadminProcedure.query(() => getStripeRenewalBatchStatus()),
  retry: superadminProcedure
    .meta({
      adminAudit: { kind: 'handler', actions: ['kiloclaw.subscription.stripe_renewal.retry'] },
    })
    .input(z.object({ runId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      setAdminAuditTarget({ type: 'other', id: input.runId });
      let result;
      try {
        result = await retryStripeRenewalBatch(input.runId, actor(ctx.user));
      } catch (error) {
        throw new TRPCError({
          code:
            error instanceof StripeRenewalBatchInputError ? error.code : 'INTERNAL_SERVER_ERROR',
          message:
            error instanceof StripeRenewalBatchInputError
              ? error.message
              : 'Unable to retry Stripe renewal batch',
          cause: error,
        });
      }
      await recordRunUsers(
        ctx,
        'kiloclaw.subscription.stripe_renewal.retry',
        result.id,
        result.retriedUserIds,
        'Retried stopping KiloClaw Stripe renewal'
      );
      return { id: result.id };
    }),
});
