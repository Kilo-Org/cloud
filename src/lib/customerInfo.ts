import { summarizeUserPayments, type UserPaymentsSummary } from '@/lib/creditTransactions';
import { hasPaymentMethodInStripe } from '@/lib/stripe-client';
import { db } from '@/lib/drizzle';
import { payment_methods, kilocode_users, type User } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { generateApiToken } from './tokens';
import { userHasOrganizations } from '@/lib/organizations/organizations';
import { hasReceivedAnyFreeWelcomeCredits } from '@/lib/welcomeCredits';

export type CustomerInfo = {
  hasPaid: boolean;
  paymentsSummary: UserPaymentsSummary;
  hasStripePaymentMethod: boolean;
  paymentStatus_untrusted: string;
  hasPaymentMethodEligibleForFreeCredits: boolean;
  user: User;
  kiloToken: string;
  hasOrganizations: boolean;
  hasReceivedWelcomeCredits: boolean;
};

export const getCustomerInfo = async (
  user: User,
  searchParams: NextAppSearchParams
): Promise<CustomerInfo> => {
  const kiloUserId = user.id;
  const hasStripePayementMethodPromise = hasPaymentMethodInStripe({
    stripeCustomerId: user.stripe_customer_id,
  });

  const paymentEligblePromise = (async () => {
    const result = await db.query.payment_methods.findFirst({
      columns: { id: true },
      where: and(
        eq(payment_methods.user_id, kiloUserId),
        eq(payment_methods.eligible_for_free_credits, true),
        isNull(payment_methods.deleted_at)
      ),
    });
    return !!result;
  })();

  const [paymentsSummary, hasOrganizations, hasReceivedWelcomeCredits] = await Promise.all([
    summarizeUserPayments(kiloUserId),
    userHasOrganizations(user.id),
    hasReceivedAnyFreeWelcomeCredits(user.id),
  ]);
  return {
    hasPaid: paymentsSummary.payments_count > 0,
    paymentsSummary,
    hasStripePaymentMethod: await hasStripePayementMethodPromise,
    hasPaymentMethodEligibleForFreeCredits: await paymentEligblePromise,
    paymentStatus_untrusted: searchParams.payment_status as string,
    user,
    kiloToken: generateApiToken(user),
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
