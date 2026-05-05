export function logImpactReferralDebug(message: string, fields?: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== 'development' && process.env.IMPACT_REFERRAL_DEBUG !== 'true') {
    return;
  }

  console.log('[impact-referral-debug]', message, {
    at: new Date().toISOString(),
    ...(fields ?? {}),
  });
}
