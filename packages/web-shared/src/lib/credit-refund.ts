import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { and, eq, or } from 'drizzle-orm';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  applyCreditRefundAdjustments,
  fetchExpiringTransactions,
  processLocalExpirations,
} from '@kilocode/web-shared/lib/creditExpiration';

export async function closeCreditExpirationsForBalanceReset(
  tx: DrizzleTransaction,
  userId: string,
  microdollarsUsed: number
): Promise<void> {
  const credits = await fetchExpiringTransactions(userId, tx);
  if (credits.length) {
    await tx.insert(credit_transactions).values(
      credits.map(credit => ({
        kilo_user_id: userId,
        original_transaction_id: credit.id,
        credit_category: 'credits_expired',
        amount_microdollars: 0,
        is_free: credit.is_free,
        description: `Closed by balance reset: ${credit.description ?? ''}`,
        original_baseline_microdollars_used: microdollarsUsed,
      }))
    );
  }
  await tx
    .update(kilocode_users)
    .set({ next_credit_expiration_at: null })
    .where(eq(kilocode_users.id, userId));
}

export async function creditRefundAdjustment(
  tx: DrizzleTransaction,
  originalTransactionId: string,
  requestedMicrodollars: number
): Promise<{ amountMicrodollars: number; microdollarsUsed: number }> {
  const credit = await tx.query.credit_transactions.findFirst({
    where: eq(credit_transactions.id, originalTransactionId),
  });
  if (!credit) throw new Error('Refund credit transaction not found');

  const [user] = await tx
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, credit.kilo_user_id))
    .for('no key update');
  if (!user) throw new Error('Refund credit owner not found');
  const result = (amountMicrodollars: number) => ({
    amountMicrodollars,
    microdollarsUsed: user.microdollars_used,
  });
  if (!credit.expiry_date) return result(requestedMicrodollars);
  const now = new Date();
  if (
    new Date(credit.expiry_date) <= now ||
    (user.next_credit_expiration_at && new Date(user.next_credit_expiration_at) <= now)
  ) {
    await processLocalExpirations(user, now, tx);
  }
  const adjustments = await tx
    .select()
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, credit.kilo_user_id),
        or(
          eq(credit_transactions.original_transaction_id, originalTransactionId),
          eq(credit_transactions.refund_for_transaction_id, originalTransactionId)
        )
      )
    );
  const expiration = adjustments.find(row => row.credit_category === 'credits_expired');
  if (!expiration) return result(requestedMicrodollars);
  const currentCredit = await tx.query.credit_transactions.findFirst({
    where: eq(credit_transactions.id, originalTransactionId),
  });
  if (!currentCredit) throw new Error('Refund credit transaction not found');

  const remaining =
    credit.amount_microdollars + adjustments.reduce((sum, row) => sum + row.amount_microdollars, 0);
  if (requestedMicrodollars < 0)
    return result(-Math.min(-requestedMicrodollars, Math.max(0, remaining)));

  // Only the consumed portion can be reinstated after expiry; unused value stays expired.
  const [entitlement] = applyCreditRefundAdjustments([currentCredit], adjustments);
  const debtRepaid = currentCredit.debt_repaid_microdollars ?? 0;
  const consumed =
    debtRepaid +
    Math.min(
      Math.max(
        entitlement.amount_microdollars - debtRepaid,
        entitlement.refunded_consumption_microdollars
      ),
      Math.max(
        0,
        (expiration.original_baseline_microdollars_used ?? 0) -
          (currentCredit.expiration_baseline_microdollars_used ?? 0)
      )
    );
  return result(Math.min(requestedMicrodollars, Math.max(0, consumed - remaining)));
}
