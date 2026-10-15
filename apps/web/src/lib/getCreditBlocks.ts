import type { CreditTransactionForBlocks } from '@kilocode/web-shared/lib/creditExpiration';
import { computeExpiration, computeCreditLotAllocations } from '@kilocode/db/credit-expiration';
import { toNonNullish } from '@/lib/utils';

type EntityForCreditBlocks = {
  id: string;
  microdollars_used: number;
  total_microdollars_acquired: number;
};

export function getCreditBlocks(
  transactions: CreditTransactionForBlocks[],
  now: Date,
  entity: EntityForCreditBlocks,
  kilo_user_id: string
) {
  const paidTransactionsCount = transactions.filter(
    t =>
      t.amount_microdollars > 0 &&
      (!t.is_free || t.paid_credit_policy != null) &&
      t.paid_credit_policy !== 'settlement' &&
      t.source_transaction_id == null
  ).length;
  const isFirstPurchase = paidTransactionsCount === 0;

  // Build lookup sets for processed transactions
  const processedById = new Set<string>();

  for (const t of transactions) {
    if (
      t.credit_category === 'credits_expired' ||
      t.credit_category === 'orb_credit_expired' ||
      t.credit_category === 'orb_credit_voided'
    ) {
      if (t.original_transaction_id) processedById.add(t.original_transaction_id);
    }
  }

  // Filter to unprocessed transactions with expiry dates
  const all_expiring_transactions = transactions.filter(
    t => t.amount_microdollars > 0 && t.expiry_date != null && !processedById.has(t.id)
  );

  const max_expiration_date = all_expiring_transactions.reduce(
    (max, t) => (t.expiry_date && new Date(t.expiry_date) > max ? new Date(t.expiry_date) : max),
    now
  );

  const expirationResult = computeExpiration(
    all_expiring_transactions,
    entity,
    max_expiration_date,
    kilo_user_id
  );
  const expiringById = new Map(all_expiring_transactions.map(t => [t.id, t]));

  const expiredWithBalance = expirationResult.newTransactions
    .map(t => {
      const block = toNonNullish(expiringById.get(t.original_transaction_id || ''));
      const balance_mUsd = -t.amount_microdollars;
      return {
        id: block.id,
        effective_date: block.created_at,
        expiry_date: block.expiry_date,
        balance_mUsd,
        amount_mUsd: block.amount_microdollars,
        is_free: block.is_free,
      };
    })
    .filter(t => t.balance_mUsd > 0);
  const totalBalance_mUsd = entity.total_microdollars_acquired - entity.microdollars_used;
  const expiringBalance_mUsd = expiredWithBalance.reduce((sum, t) => sum + t.balance_mUsd, 0);
  const nonExpiringBalance_mUsd = totalBalance_mUsd - expiringBalance_mUsd;
  let remainingNonExpiringBalance = Math.max(0, nonExpiringBalance_mUsd);
  const nonExpiring = computeCreditLotAllocations(
    transactions.filter(transaction => !processedById.has(transaction.id)),
    entity
  )
    .filter(({ transaction }) => transaction.expiry_date === null)
    .map(({ transaction, remaining_microdollars }) => {
      const balance_mUsd = Math.min(remaining_microdollars, remainingNonExpiringBalance);
      remainingNonExpiringBalance -= balance_mUsd;
      return {
        id: transaction.id,
        effective_date: transaction.created_at,
        expiry_date: transaction.expiry_date,
        amount_mUsd: transaction.amount_microdollars,
        balance_mUsd,
        is_free: transaction.is_free,
      };
    })
    .filter(transaction => transaction.balance_mUsd > 0);

  const creditBlocks = [...expiredWithBalance, ...nonExpiring];

  // Extract deduction transactions (negative amounts) for display.
  // These include KiloClaw subscription charges and settlement deductions.
  const deductions = transactions
    .filter(tx => tx.amount_microdollars < 0)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(tx => ({
      id: tx.id,
      date: tx.created_at,
      description: tx.description ?? tx.credit_category ?? 'Credit deduction',
      credit_category: tx.credit_category,
      amount_mUsd: tx.amount_microdollars, // negative
    }));

  return {
    creditBlocks,
    deductions,
    totalBalance_mUsd,
    isFirstPurchase,
  };
}
