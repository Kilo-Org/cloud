import {
  summarizeUserPayments,
  type UserPaymentsSummary,
} from '@kilocode/web-shared/lib/creditTransactions';
import { hasPaymentMethodInStripe } from '@kilocode/web-shared/lib/stripe-client';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { payment_methods, kilocode_users, type User } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { userHasOrganizations } from '@kilocode/web-shared/lib/organizations/organizations';
import { hasReceivedAnyFreeWelcomeCredits } from '@kilocode/web-shared/lib/welcomeCredits';

export type CustomerInfo = {
  hasPaid: boolean;
  paymentsSummary: UserPaymentsSummary;
  hasStripePaymentMethod: boolean;
  paymentStatus_untrusted: string;
  hasPaymentMethodEligibleForFreeCredits: boolean;
  user: User;
  hasOrganizations: boolean;
  hasReceivedWelcomeCredits: boolean;
};

export const getCustomerInfo = async (
  user: User,
  searchParams: NextAppSearchParams
): Promise<CustomerInfo> => {
  const kiloUserId = user.id;

  // Every read starts here, so a rejection from any of them is observed by the
  // `Promise.all` below and reaches the caller's error handling at the point it
  // happens, instead of sitting unhandled until its promise is awaited later.
  const [
    paymentsSummary,
    hasOrganizations,
    hasReceivedWelcomeCredits,
    hasStripePaymentMethod,
    hasPaymentMethodEligibleForFreeCredits,
  ] = await Promise.all([
    summarizeUserPayments(kiloUserId),
    userHasOrganizations(user.id),
    hasReceivedAnyFreeWelcomeCredits(user.id),
    hasPaymentMethodInStripe({
      stripeCustomerId: user.stripe_customer_id,
    }),
    (async () => {
      const result = await db.query.payment_methods.findFirst({
        columns: { id: true },
        where: and(
          eq(payment_methods.user_id, kiloUserId),
          eq(payment_methods.eligible_for_free_credits, true),
          isNull(payment_methods.deleted_at)
        ),
      });
      return !!result;
    })(),
  ]);
  return {
    hasPaid: paymentsSummary.payments_count > 0,
    paymentsSummary,
    hasStripePaymentMethod,
    hasPaymentMethodEligibleForFreeCredits,
    paymentStatus_untrusted: searchParams.payment_status as string,
    user,
    hasOrganizations: hasOrganizations,
    hasReceivedWelcomeCredits,
  };
};
export type UserValidationInfo = Pick<User, 'has_validation_stytch'>;

export const updateStytchValidation = async (user: User, newValues: UserValidationInfo) => {
  // Use optimistic concurrency control - only update if old values still match
  await db
    .update(kilocode_users)
    .set({
      has_validation_stytch: newValues.has_validation_stytch,
    })
    .where(
      and(
        eq(kilocode_users.id, user.id),
        user.has_validation_stytch === null
          ? isNull(kilocode_users.has_validation_stytch)
          : eq(kilocode_users.has_validation_stytch, user.has_validation_stytch),
        eq(
          kilocode_users.has_validation_novel_card_with_hold,
          user.has_validation_novel_card_with_hold
        )
      )
    );
};
