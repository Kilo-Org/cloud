import { type AccessRequiredSubcase } from '@/lib/analytics/onboarding-events';
import { WEB_BASE_URL } from '@/lib/config';

/** Support inbox, the same address the feedback flow writes to (see lib/feedback). */
export const SUPPORT_EMAIL = 'hi@kilo.ai';

const SUBSCRIBE_SUBCASES: ReadonlySet<AccessRequiredSubcase> = new Set([
  'trial_expired',
  'subscription_canceled',
  'subscription_past_due',
]);

/**
 * Where an access-issue CTA should send the user: billing (/claw), the support
 * inbox (quarantined — only the team can restore that state), or the site.
 */
export function resolveAccessIssueUrl(subcase: AccessRequiredSubcase): string {
  if (subcase === 'quarantined') {
    return `mailto:${SUPPORT_EMAIL}`;
  }
  return SUBSCRIBE_SUBCASES.has(subcase) ? `${WEB_BASE_URL}/claw` : WEB_BASE_URL;
}

/** The noun a failure toast should name for one access-issue URL. */
export function accessIssueTargetLabel(url: string): string {
  return url.startsWith('mailto:') ? SUPPORT_EMAIL : 'kilo.ai';
}
