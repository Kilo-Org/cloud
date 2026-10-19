// Pure selection of the inline / toast copy for a failed cloud `prepareSession`
// (new-session form, Continue clone, and the OS start action's shared core).
// Classification lives in `isCloudPrepareRetryableError` (retry semantics) —
// this helper only picks the localized message, so the raw server string never
// reaches the UI. Known failure classes map to actionable copy; everything
// else, including an unclassified BAD_REQUEST detail, gets the localized
// generic line.

import { i18n } from '@/i18n';
import { readTrpcErrorField } from '@/lib/trpc-error';

/**
 * The localized failure copy for a rejected cloud prepare. Known tRPC codes
 * name what the user can do next; every other rejection — an unclassified
 * server detail, an unknown transport failure — gets the generic service line.
 */
export function cloudPrepareFailureMessage(error: unknown): string {
  const code = readTrpcErrorField(error, 'code');
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return i18n.t('agentChat.newSession.checkOrganizationAccess');
  }
  if (code === 'PAYMENT_REQUIRED') {
    return i18n.t('agentChat.session.notEnoughCredits');
  }
  return i18n.t('queryError.serverDescription');
}
