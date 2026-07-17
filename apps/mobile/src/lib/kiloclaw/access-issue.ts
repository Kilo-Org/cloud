import { type AccessRequiredSubcase } from '@/lib/analytics/onboarding-events';
import { WEB_BASE_URL } from '@/lib/config';

const SUBSCRIBE_SUBCASES: ReadonlySet<AccessRequiredSubcase> = new Set([
  'trial_expired',
  'subscription_canceled',
  'subscription_past_due',
]);

/** Where an access-issue CTA should send the user: billing (/claw) or the generic site. */
export function resolveAccessIssueUrl(subcase: AccessRequiredSubcase): string {
  return SUBSCRIBE_SUBCASES.has(subcase) ? `${WEB_BASE_URL}/claw` : WEB_BASE_URL;
}
