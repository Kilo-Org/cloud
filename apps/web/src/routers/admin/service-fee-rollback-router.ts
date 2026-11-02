import * as z from 'zod';

import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { client as stripeClient } from '@kilocode/web-shared/lib/stripe-client';

import {
  type AdminActionEntry,
  organizationActionTarget,
  recordAdminActions,
  userActionTarget,
} from '@/lib/admin/admin-action-audit';
import {
  SERVICE_FEE_ROLLBACK_MAX_BATCH_SIZE,
  executeServiceFeeRollbackBatch,
  getServiceFeeRollbackOverview,
  reconcileStaleServiceFeeRollbackClaims,
  type ServiceFeeRollbackReconcileResult,
  type ServiceFeeRollbackRowResult,
} from '@/lib/service-fees/rollback';
import { superadminProcedure } from '@/lib/trpc/admin-procedures';

const ExecuteBatchSchema = z.object({
  limit: z.number().int().min(1).max(SERVICE_FEE_ROLLBACK_MAX_BATCH_SIZE),
});

// Rows where Stripe may hold a refund this run created or confirmed. An
// unknown outcome is audited because the refund may exist even though the
// request failed.
const AUDITED_BATCH_STATUSES = new Set<ServiceFeeRollbackRowResult['status']>([
  'refunded',
  'already_refunded',
  'outcome_unknown',
]);
const AUDITED_RECONCILE_STATUSES = new Set<ServiceFeeRollbackReconcileResult['status']>([
  'succeeded',
  'failed',
]);

type AuditableRow = Pick<
  ServiceFeeRollbackRowResult,
  | 'assessmentKey'
  | 'flow'
  | 'kiloUserId'
  | 'organizationId'
  | 'amountMinor'
  | 'currency'
  | 'stripeChargeId'
  | 'stripeRefundId'
  | 'reason'
> & { status: string };

function auditEntry(
  action: AdminActionEntry['action'],
  message: string,
  row: AuditableRow
): AdminActionEntry {
  return {
    action,
    target: row.organizationId
      ? organizationActionTarget(row.organizationId)
      : row.kiloUserId
        ? userActionTarget(row.kiloUserId)
        : null,
    message,
    metadata: {
      assessmentKey: row.assessmentKey,
      flow: row.flow,
      status: row.status,
      stripeChargeId: row.stripeChargeId,
      stripeRefundId: row.stripeRefundId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      reason: row.reason,
    },
  };
}

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
        .filter(row => AUDITED_BATCH_STATUSES.has(row.status))
        .map(row =>
          auditEntry(
            'service_fee.rollback_refund',
            row.status === 'outcome_unknown'
              ? 'Service fee refund attempted with unknown outcome via service fee rollback'
              : 'Refunded service fee via service fee rollback',
            row
          )
        )
    );

    return results;
  }),

  reconcileStale: superadminProcedure.mutation(async ({ ctx }) => {
    const results = await reconcileStaleServiceFeeRollbackClaims({
      database: db,
      stripe: stripeClient,
    });

    await recordAdminActions(
      ctx,
      results
        .filter(row => AUDITED_RECONCILE_STATUSES.has(row.status))
        .map(row =>
          auditEntry(
            'service_fee.rollback_reconcile',
            row.status === 'succeeded'
              ? 'Confirmed service fee refund via service fee rollback reconcile'
              : 'Released service fee claim for retry via service fee rollback reconcile',
            row
          )
        )
    );

    return results;
  }),
});
