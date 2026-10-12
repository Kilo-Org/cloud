import type { User } from '@kilocode/db/schema';
import { grantCreditForCategory } from './promotionalCredits';
import { summarizeUserPayments } from '@kilocode/web-shared/lib/creditTransactions';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { FIRST_TOPUP_BONUS_AMOUNT } from '@kilocode/web-shared/lib/constants';

export async function processFirstTopupBonus(user: User) {
  if (FIRST_TOPUP_BONUS_AMOUNT <= 0) return;

  if ((await summarizeUserPayments(user.id, db)).payments_count !== 1) return;

  await grantCreditForCategory(user, {
    credit_category: 'first-topup-bonus',
    counts_as_selfservice: false,
    amount_usd: FIRST_TOPUP_BONUS_AMOUNT,
  });
}
