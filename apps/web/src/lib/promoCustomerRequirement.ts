import { user_auth_provider } from '@kilocode/db/schema';
import type { CustomerInfo } from '@/lib/customerInfo';
import { db } from '@/lib/drizzle';
import type { OptionalError } from '@/lib/maybe-result';
import { verifyOrError, whenOkTry, failureResult, successResult } from '@/lib/maybe-result';
import { and, eq } from 'drizzle-orm';
import type { Awaitable } from 'next-auth';

export type CustomerRequirement = (customerInfo: CustomerInfo) => Awaitable<OptionalError<string>>;
export type SyncCustomerRequirement = (customerInfo: CustomerInfo) => OptionalError<string>;
export const has_holdOrPayment: SyncCustomerRequirement = customerInfo =>
  verifyOrError(
    customerInfo.user.has_validation_novel_card_with_hold || customerInfo.hasPaid,
    'You must have bought credits at least once to redeem this code.' // removed hold from message, as that isnt an available option to new users
  );
// Wrapped versions with error messages

export const has_used1usd_andHoldOrPayment: SyncCustomerRequirement = customerInfo =>
  whenOkTry(
    verifyOrError(
      customerInfo.user.microdollars_used >= 1000 * 1000,
      'You must have used at least $1 in credits and bought credits at least once to redeem this code.' // removed hold from message, as that isnt an available option to new users
    ),
    () => has_holdOrPayment(customerInfo)
  );

export const has_Payment: SyncCustomerRequirement = customerInfo =>
  verifyOrError(
    customerInfo.hasPaid,
    'You must have purchased credits at least once to redeem this code.'
  );

export const has_stytchApprovedOrHoldOrPayment: SyncCustomerRequirement = customerInfo =>
  verifyOrError(
    customerInfo.user.has_validation_stytch ||
      customerInfo.user.has_validation_novel_card_with_hold ||
      customerInfo.hasPaid,
    'You must have received the free welcome credits to apply for this code. Alternatively, you can buy credits once to apply.'
  );

export const has_githubAuthAndWelcomeCredits: CustomerRequirement = async customerInfo => {
  const has_github_auth = await db.query.user_auth_provider.findFirst({
    where: and(
      eq(user_auth_provider.kilo_user_id, customerInfo.user.id),
      eq(user_auth_provider.provider, 'github')
    ),
    columns: { kilo_user_id: true },
  });
  if (!has_github_auth)
    return failureResult(
      'You must have a GitHub account and have linked it to your kilocode account to apply this code.'
    );
  return has_stytchApprovedOrHoldOrPayment(customerInfo);
};

export function created_before(cutoff: Date): SyncCustomerRequirement {
  return customerInfo =>
    verifyOrError(
      new Date(customerInfo.user.created_at) < cutoff,
      'Your account was created after the eligibility cutoff date for this promotion.'
    );
}

export const has_githubAuth: CustomerRequirement = async customerInfo => {
  const has_github_auth = await db.query.user_auth_provider.findFirst({
    where: and(
      eq(user_auth_provider.kilo_user_id, customerInfo.user.id),
      eq(user_auth_provider.provider, 'github')
    ),
    columns: { kilo_user_id: true },
  });
  if (!has_github_auth)
    return failureResult(
      'You must have a GitHub account and have linked it to your kilocode account to apply this code.'
    );
  return successResult();
};
