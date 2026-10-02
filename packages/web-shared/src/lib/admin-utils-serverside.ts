import { db } from '@/lib/drizzle';
import type { PaymentMethod, User } from '@kilocode/db/schema';
import { payment_methods } from '@kilocode/db/schema';
import { inArray, eq, and, isNull } from 'drizzle-orm';

export const describePaymentMethods = (
  paymentMethods: PaymentMethod[],
  user: Pick<User, 'id' | 'has_validation_novel_card_with_hold'>,
  hasReceivedAnyFreeWelcomeCredits: boolean
) => {
  const activePaymentMethods = paymentMethods.filter(pm => !pm.deleted_at);

  // if true, user already received free credits for card validation
  // maybe actually did the hold flow, or maybe got it from our welcome credits stytch reward

  if (hasReceivedAnyFreeWelcomeCredits && !user.has_validation_novel_card_with_hold) {
    return 'stytch welcome credits';
  }
  if (user.has_validation_novel_card_with_hold) return 'has hold';
  if (paymentMethods.length === 0) return 'none';
  if (activePaymentMethods.some(pm => pm.eligible_for_free_credits)) return 'eligible for hold';
  if (paymentMethods.some(pm => pm.eligible_for_free_credits)) return 'prev. eligible';
  if (activePaymentMethods.length === 0) return 'all deleted';
  return 'has ineligible';
};

export async function getPaymentStatusByUserIds(userIds: string[]) {
  const paymentMethodsData = await db.query.payment_methods.findMany({
    where: inArray(payment_methods.user_id, userIds),
  });

  return Object.groupBy(paymentMethodsData, pm => pm.user_id);
}

export async function hasPaymentMethod(userId: string): Promise<boolean> {
  const result = await db.query.payment_methods.findFirst({
    columns: { id: true },
    where: and(eq(payment_methods.user_id, userId), isNull(payment_methods.deleted_at)),
  });

  return result !== undefined;
}
