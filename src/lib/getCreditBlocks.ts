import type { CreditTransactionForBlocks, UserForLocalExpiration } from '@/lib/creditExpiration';
import { computeExpiration } from '@/lib/creditExpiration';
import { toNonNullish } from '@/lib/utils';

export function getCreditBlocks(
  transactions: CreditTransactionForBlocks[],
  now: Date,
  user: UserForLocalExpiration
) {
  const paidTransactionsCount = transactions.filter(
    t => t.amount_microdollars > 0 && !t.is_free
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
    t => t.expiry_date != null && !processedById.has(t.id)
  );

  const max_expiration_date = all_expiring_transactions.reduce(
    (max, t) => (t.expiry_date && new Date(t.expiry_date) > max ? new Date(t.expiry_date) : max),
    now
  );

  const expirationResult = computeExpiration(
    all_expiring_transactions,
    user,
    max_expiration_date,
    user.id
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
  const totalBalance_mUsd = user.total_microdollars_acquired - user.microdollars_used;
  const expiringBalance_mUsd = expiredWithBalance.reduce((sum, t) => sum + t.balance_mUsd, 0);
  const nonExpiringBalance_mUsd = totalBalance_mUsd - expiringBalance_mUsd;
  let prefixSumMusd = 0;
  const nonExpiring = transactions
    .filter(tx => tx.expiry_date == null)
    .sort((a, b) => {
      // Sort by effective_date (newest first)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })
    .map(tx => {
      const balance_mUsd = Math.min(
        tx.amount_microdollars,
        nonExpiringBalance_mUsd - prefixSumMusd
      );
      prefixSumMusd += tx.amount_microdollars;
      return {
        id: tx.id,
        effective_date: tx.created_at,
        expiry_date: tx.expiry_date,
        amount_mUsd: tx.amount_microdollars,
        balance_mUsd,
        is_free: tx.is_free,
      };
    })
    .filter(tx => tx.balance_mUsd > 0)
    .reverse();

  const creditBlocks = [...expiredWithBalance, ...nonExpiring];

  return {
    creditBlocks,
    totalBalance_mUsd,
    isFirstPurchase,
  };
}
