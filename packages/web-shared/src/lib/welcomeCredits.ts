import { db } from '@/lib/drizzle';
import { credit_transactions } from '@kilocode/db/schema';
import { and, inArray } from 'drizzle-orm';

export async function hasReceivedAnyFreeWelcomeCredits(userId: string) {
  return (await getUsersWithAnyFreeWelcomeCredits([userId])).has(userId);
}

export async function getUsersWithAnyFreeWelcomeCredits(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const disqualifyingCategories = [
    'card-validation-no-stytch', // legacy users ( < 15-08-2025)
    'card-validation-upgrade', // legacy users ( < 15-08-2025)
    'stytch-validation', // legacy users ( < 15-08-2025)
    'automatic-welcome-credits', // legacy users < 30-09-2025
  ];

  const results = await db
    .select({
      kilo_user_id: credit_transactions.kilo_user_id,
      credit_category: credit_transactions.credit_category,
    })
    .from(credit_transactions)
    .where(
      and(
        inArray(credit_transactions.kilo_user_id, userIds),
        inArray(credit_transactions.credit_category, disqualifyingCategories)
      )
    );

  return new Set(results.map(r => r.kilo_user_id));
}
