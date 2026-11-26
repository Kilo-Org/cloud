import { superadminProcedure } from '@/lib/trpc/admin-procedures';
import {
  getCreditRenewalPreview,
  stopCreditRenewals,
} from '@/lib/kiloclaw/admin-credit-renewal-batch';
import {
  recordAdminAction,
  recordAdminActions,
  userActionTarget,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import * as z from 'zod';

export const ADMIN_STOP_CREDIT_RENEWALS_CONFIRMATION = 'STOP CREDIT RENEWALS';

export const adminKiloclawCreditRenewalsRouter = createTRPCRouter({
  preview: superadminProcedure.query(() => getCreditRenewalPreview()),
  stop: superadminProcedure
    .meta({
      adminAudit: { kind: 'handler', actions: ['kiloclaw.subscription.credit_renewal.stop'] },
    })
    .input(
      z.object({
        confirmation: z.literal(ADMIN_STOP_CREDIT_RENEWALS_CONFIRMATION),
      })
    )
    .mutation(async ({ ctx }) => {
      const result = await stopCreditRenewals(
        {
          id: ctx.user.id,
          email: ctx.user.google_user_email,
          name: ctx.user.google_user_name,
        },
        stopped =>
          recordAdminActions(
            ctx,
            stopped.map(({ subscriptionId, userId }) => ({
              action: 'kiloclaw.subscription.credit_renewal.stop' as const,
              target: userActionTarget(userId),
              message: 'Stopped KiloClaw credit renewal',
              metadata: { subscriptionId },
            }))
          )
      );
      if (result.updated === 0) {
        await recordAdminAction(ctx, {
          action: 'kiloclaw.subscription.credit_renewal.stop',
          target: null,
          message: 'Stopped no KiloClaw credit renewals',
          metadata: { updated: 0, remaining: result.remaining },
        });
      }
      return result;
    }),
});
