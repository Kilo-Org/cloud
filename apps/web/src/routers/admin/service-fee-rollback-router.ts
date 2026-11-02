import * as z from 'zod';

import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { client as stripeClient } from '@kilocode/web-shared/lib/stripe-client';

import {
  organizationActionTarget,
  recordAdminActions,
  userActionTarget,
} from '@/lib/admin/admin-action-audit';
import {
  SERVICE_FEE_ROLLBACK_MAX_BATCH_SIZE,
  executeServiceFeeRollbackBatch,
  getServiceFeeRollbackOverview,
  reconcileStaleServiceFeeRollbackClaims,
} from '@/lib/service-fees/rollback';
import { superadminProcedure } from '@/lib/trpc/admin-procedures';

const ExecuteBatchSchema = z.object({
  limit: z.number().int().min(1).max(SERVICE_FEE_ROLLBACK_MAX_BATCH_SIZE),
});

export const adminServiceFeeRollbackRouter = createTRPCRouter({
  overview: adminProcedure.query(() => getServiceFeeRollbackOverview(db)),

  executeBatch: superadminProcedure.input(ExecuteBatchSchema).mutation(async ({ input, ctx }) => {
    const results = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripeClient,
      adminKiloUserId: ctx.user.id,
      limit: input.limit,
    });

    await recordAdminActions(
      ctx,
      results
        .filter(row => row.status === 'refunded')
        .map(row => ({
          action: 'service_fee.rollback_refund' as const,
          target: row.organizationId
            ? organizationActionTarget(row.organizationId)
            : row.kiloUserId
              ? userActionTarget(row.kiloUserId)
              : null,
          message: 'Refunded service fee via service fee rollback',
          metadata: {
            assessmentKey: row.assessmentKey,
            flow: row.flow,
            stripeChargeId: row.stripeChargeId,
            stripeRefundId: row.stripeRefundId,
            amountMinor: row.amountMinor,
            currency: row.currency,
          },
        }))
    );

    return results;
  }),

  reconcileStale: superadminProcedure.mutation(() =>
    reconcileStaleServiceFeeRollbackClaims({ database: db, stripe: stripeClient })
  ),
});
