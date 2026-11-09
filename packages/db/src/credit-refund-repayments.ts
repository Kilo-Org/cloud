import type { WorkerDb } from './client';
import { credit_transactions } from './schema';
import type { CreditOwner } from './credit-expiration';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';

type DrizzleTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

export function refundDebtAllocationCategory(refundTransactionId: string) {
  return `refund_debt_absorbed:${refundTransactionId}`;
}

function ownerCondition(owner: CreditOwner) {
  return owner.type === 'organization'
    ? eq(credit_transactions.organization_id, owner.id)
    : and(
        eq(credit_transactions.kilo_user_id, owner.id),
        isNull(credit_transactions.organization_id)
      );
}

/** Unreversed refunds with spent principal not yet repaid, oldest first; repayments settle them in this order. */
export async function outstandingRefundDebts(tx: DrizzleTransaction, owner: CreditOwner) {
  const refunds = await tx
    .select()
    .from(credit_transactions)
    .where(
      and(
        ownerCondition(owner),
        isNotNull(credit_transactions.refund_principal_microdollars),
        lte(credit_transactions.refund_principal_microdollars, 0),
        lte(credit_transactions.amount_microdollars, 0)
      )
    )
    .orderBy(asc(credit_transactions.created_at), asc(credit_transactions.id));
  if (refunds.length === 0) return [];
  const categories = refunds.map(refund => refundDebtAllocationCategory(refund.id));
  const allocations = await tx
    .select()
    .from(credit_transactions)
    .where(and(ownerCondition(owner), inArray(credit_transactions.credit_category, categories)));
  const reversals = await tx
    .select({ source_transaction_id: credit_transactions.source_transaction_id })
    .from(credit_transactions)
    .where(
      and(
        ownerCondition(owner),
        isNotNull(credit_transactions.refund_principal_microdollars),
        sql`${credit_transactions.refund_principal_microdollars} > 0`,
        inArray(
          credit_transactions.source_transaction_id,
          refunds.map(refund => refund.id)
        )
      )
    );
  const restored = new Set(reversals.map(row => row.source_transaction_id));
  return refunds
    .filter(refund => !restored.has(refund.id))
    .map(refund => ({
      refund,
      amount: Math.max(
        0,
        -refund.amount_microdollars -
          refund.retired_microdollars -
          allocations
            .filter(
              allocation => allocation.credit_category === refundDebtAllocationCategory(refund.id)
            )
            .reduce(
              (sum, allocation) =>
                sum + allocation.retired_microdollars + allocation.consumed_microdollars,
              0
            )
      ),
    }));
}

export async function recordRefundDebtRepayment(
  tx: DrizzleTransaction,
  params: {
    owner: CreditOwner;
    transactionId: string;
    priorAcquired: number;
    priorUsed: number;
    amountMicrodollars: number;
  }
): Promise<void> {
  let repayment = Math.min(
    params.amountMicrodollars,
    Math.max(0, params.priorUsed - params.priorAcquired)
  );
  if (repayment <= 0) return;
  const debts = await outstandingRefundDebts(tx, params.owner);
  if (debts.length === 0) return;
  const unrelatedDebt = Math.max(
    0,
    params.priorUsed - params.priorAcquired - debts.reduce((sum, debt) => sum + debt.amount, 0)
  );
  repayment = Math.max(0, repayment - unrelatedDebt);
  if (repayment === 0) return;
  const [grant] = await tx
    .select()
    .from(credit_transactions)
    .where(eq(credit_transactions.id, params.transactionId))
    .limit(1);
  if (!grant) throw new Error('Refund debt repayment grant not found');
  for (const debt of debts) {
    const amount = Math.min(repayment, debt.amount);
    if (amount <= 0) continue;
    await tx.insert(credit_transactions).values({
      kilo_user_id: grant.kilo_user_id,
      organization_id: grant.organization_id,
      source_transaction_id: grant.id,
      amount_microdollars: 0,
      consumed_microdollars: amount,
      is_free: true,
      credit_category: refundDebtAllocationCategory(debt.refund.id),
      description: 'Refund debt absorbed by credit grant',
      paid_credit_policy: grant.paid_credit_policy ?? (grant.is_free ? null : 'legacy'),
      credit_source: grant.credit_source,
      expiry_date: grant.expiry_date,
      created_at: grant.created_at,
      original_baseline_microdollars_used: params.priorUsed,
    });
    repayment -= amount;
  }
}
