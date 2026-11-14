import type { CustomerBillingFailure } from '@kilocode/session-ingest-contracts';

export function billingFailureFromAdmission(
  payer: CustomerBillingFailure['payer'],
  failure: {
    code: 'insufficient_credits' | 'meter_unavailable' | 'stopping';
    remainingMicrodollars?: number;
    minimumRequiredMicrodollars?: number;
  }
): CustomerBillingFailure {
  return {
    code:
      failure.code === 'insufficient_credits'
        ? 'INSUFFICIENT_CREDITS'
        : failure.code === 'stopping'
          ? 'COMPUTE_STOPPING'
          : 'BILLING_UNAVAILABLE',
    payer,
    retryable: true,
    remainingMicrodollars: failure.remainingMicrodollars,
    minimumRequiredMicrodollars: failure.minimumRequiredMicrodollars,
  };
}
