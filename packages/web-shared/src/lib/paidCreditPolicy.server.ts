import { PAID_CREDIT_EXPIRATION_EFFECTIVE_AT } from '@kilocode/web-shared/lib/config.server';
import type { PaidCreditSource, PaidCreditTerms } from '@kilocode/web-shared/lib/paidCreditPolicy';

export function getPaidCreditTerms(
  source: PaidCreditSource,
  purchasedAt: Date | string = new Date()
): PaidCreditTerms {
  if (source === 'apple') return 'apple_exempt';
  const cutoff = PAID_CREDIT_EXPIRATION_EFFECTIVE_AT;
  if (!cutoff) return 'legacy';
  const effectiveTime = new Date(cutoff).getTime();
  const purchaseTime = new Date(purchasedAt).getTime();
  return Number.isFinite(effectiveTime) &&
    Number.isFinite(purchaseTime) &&
    purchaseTime >= effectiveTime
    ? 'one_year'
    : 'legacy';
}
