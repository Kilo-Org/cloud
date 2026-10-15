export type PaidCreditTerms = 'legacy' | 'one_year' | 'apple_exempt';
export type PaidCreditSource = 'stripe' | 'google_play' | 'apple' | 'pass' | 'admin' | 'settlement';
export type PaidCreditGrant = {
  source: PaidCreditSource;
  purchasedAt: Date | string;
  issuedAt?: Date | string;
  terms?: PaidCreditTerms;
};

export function addCalendarYearUtc(value: Date | string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid paid credit issuance date');
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString();
}

export function getPaidCreditPolicyPresentation(effectiveAt: string | null, now = new Date()) {
  const cutoff = effectiveAt === null ? NaN : new Date(effectiveAt).getTime();
  const enabled = Number.isFinite(cutoff) && cutoff <= now.getTime();
  return {
    enabled,
    effectiveAt: Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null,
    creditExpiryPolicy: enabled ? ('one_year' as const) : ('never' as const),
    passExpiryPolicy: enabled ? ('one_year' as const) : ('never' as const),
  };
}

export function resolvePaidCreditPolicy(grant: PaidCreditGrant) {
  if (grant.source === 'settlement') {
    return { paid_credit_policy: 'settlement', credit_source: grant.source, expiry_date: null };
  }
  if (grant.source === 'apple' || grant.terms === 'apple_exempt') {
    return { paid_credit_policy: 'apple_exempt', credit_source: grant.source, expiry_date: null };
  }
  if (grant.terms !== 'one_year') {
    return { paid_credit_policy: 'legacy', credit_source: grant.source, expiry_date: null };
  }
  return {
    paid_credit_policy: 'one_year',
    credit_source: grant.source,
    expiry_date: addCalendarYearUtc(grant.issuedAt ?? grant.purchasedAt),
  };
}
