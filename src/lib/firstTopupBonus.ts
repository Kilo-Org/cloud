import type { User } from '@kilocode/db/schema';
import { grantCreditForCategory } from './promotionalCredits';
import { summarizeUserPayments } from '@/lib/creditTransactions';
import { db } from '@/lib/drizzle';
import { FIRST_TOPUP_BONUS_AMOUNT } from '@/lib/constants';

export async function processFirstTopupBonus(user: User) {
  // this is run after topping up, so a user which has done their first
  // topup will have exactly one topup
  // Uses primary db for read-after-write consistency (payment was just inserted)
  if ((await summarizeUserPayments(user.id, db)).payments_count !== 1) return;

  await grantCreditForCategory(user, {
    credit_category: 'first-topup-bonus',
    counts_as_selfservice: false,
    amount_usd: FIRST_TOPUP_BONUS_AMOUNT(new Date(Date.now() - 15 * 60 * 1000)), //15min grace period
  });
}
