/**
 * Returns true when the unified Impact debug logger should emit. Honors:
 *   - NODE_ENV === 'development' (always-on locally)
 *   - IMPACT_REFERRAL_DEBUG=true (server-side opt-in for staging/prod tests)
 *   - IMPACT_ADVOCATE_DEBUG_LOGGING=true|1|yes (legacy flag still honored)
 */
export function isImpactDebugLoggingEnabled(): boolean {
  if (process.env.NODE_ENV === 'development') return true;
  if (process.env.IMPACT_REFERRAL_DEBUG === 'true') return true;
  const advocate = process.env.IMPACT_ADVOCATE_DEBUG_LOGGING?.trim().toLowerCase();
  return advocate === 'true' || advocate === '1' || advocate === 'yes';
}

export function logImpactReferralDebug(message: string, fields?: Record<string, unknown>): void {
  if (!isImpactDebugLoggingEnabled()) return;

  console.log('[impact-referral-debug]', message, {
    at: new Date().toISOString(),
    ...(fields ?? {}),
  });
}

/** Truncate a response body for safe logging. Impact responses can be large. */
export function truncateForLog(body: string | null | undefined, max = 500): string | null {
  if (body == null) return null;
  if (body.length <= max) return body;
  return `${body.slice(0, max)}… [truncated ${body.length - max} chars]`;
}
