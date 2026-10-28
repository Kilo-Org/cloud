export type PaidCreditPolicyTerms = { creditExpiryPolicy: 'one_year' | 'never' } | undefined;

/**
 * The term shown next to "Purchased credits" on the credits page. New paid
 * credits follow the live policy; a claim rendered before the policy loads, or
 * after it fails, must not repeat the old non-expiration promise.
 */
export function purchasedCreditTermsText(policy: PaidCreditPolicyTerms, isError: boolean): string {
  if (isError) return 'Terms unavailable';
  if (policy === undefined) return 'Loading terms...';
  return policy.creditExpiryPolicy === 'one_year'
    ? 'Expire one year after purchase'
    : 'Do not expire';
}
