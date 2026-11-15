import { superadminProcedure } from '@/lib/trpc/admin-procedures';
import {
  getCreditRenewalPreview,
  stopCreditRenewals,
} from '@/lib/kiloclaw/admin-credit-renewal-batch';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import * as z from 'zod';

export const ADMIN_STOP_CREDIT_RENEWALS_CONFIRMATION = 'STOP CREDIT RENEWALS';

export const adminKiloclawCreditRenewalsRouter = createTRPCRouter({
  preview: superadminProcedure.query(() => getCreditRenewalPreview()),
  stop: superadminProcedure
    .input(
      z.object({
        confirmation: z.literal(ADMIN_STOP_CREDIT_RENEWALS_CONFIRMATION),
      })
    )
    .mutation(({ ctx }) =>
      stopCreditRenewals({
        id: ctx.user.id,
        email: ctx.user.google_user_email,
        name: ctx.user.google_user_name,
      })
    ),
});
