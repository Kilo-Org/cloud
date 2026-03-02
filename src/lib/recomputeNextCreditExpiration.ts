import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { fetchExpiringTransactions } from '@/lib/creditExpiration';

export type RecomputeNextCreditExpirationResult = {
  oldValue: string | null;
  newValue: string | null;
  updated: boolean;
};

/**
 * Recompute and update the next_credit_expiration_at field for a user.
 * This is the earliest expiry date among all non-exhausted expiring credit transactions.
 * Uses optimistic locking to avoid race conditions.
 */
export async function recomputeNextCreditExpiration(
  kiloUserId: string,
  options: { dryRun?: boolean } = {}
): Promise<RecomputeNextCreditExpirationResult> {
  const { dryRun = false } = options;

  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, kiloUserId),
    columns: { next_credit_expiration_at: true },
  });

  const oldValue = user?.next_credit_expiration_at ?? null;

  const newValue =
    (await fetchExpiringTransactions(kiloUserId))
      .map(t => t.expiry_date)
      .filter(Boolean)
      .sort()[0] ?? null;

  if (dryRun || oldValue === newValue) {
    return { oldValue, newValue, updated: false };
  }

  const result = await db
    .update(kilocode_users)
    .set({ next_credit_expiration_at: newValue })
    .where(
      and(
        eq(kilocode_users.id, kiloUserId),
        oldValue === null
          ? isNull(kilocode_users.next_credit_expiration_at)
          : eq(kilocode_users.next_credit_expiration_at, oldValue)
      )
    );

  return { oldValue, newValue, updated: (result.rowCount ?? 0) > 0 };
}
