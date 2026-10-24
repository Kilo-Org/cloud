// Pure selection of the inline / toast copy for a failed cloud `prepareSession`
// (new-session form, Continue clone, and the OS start action's shared core).
// Classification lives in `isCloudPrepareRetryableError` (retry semantics) —
// this helper only picks the localized message, so the raw server string never
// reaches the UI. A rejection whose sentence the app knows maps to its own
// actionable copy; everything else, including an unclassified BAD_REQUEST
// detail, gets the localized generic line.

import { i18n } from '@/i18n';
import { knownServerErrorMessage } from '@/lib/server-error-copy';
import { readTrpcErrorField } from '@/lib/trpc-error';

/**
 * The localized failure copy for a rejected cloud prepare. Only failures the
 * message names precisely, plus the missing-selection code, get actionable
 * copy; every other rejection — an unclassified server detail, an unknown
 * transport failure — gets the generic service line, because the tRPC code
 * alone does not identify the failure. Prepare resolves the requested profile
 * before it registers the session, so its only `NOT_FOUND` is a profile that
 * no longer exists: the reader refreshes the selection instead of retrying.
 */
export function cloudPrepareFailureMessage(error: unknown): string {
  const known = knownServerErrorMessage(error);
  if (known != null) {
    return known;
  }
  const code = readTrpcErrorField(error, 'code');
  if (code === 'NOT_FOUND') {
    return i18n.t('queryError.notFoundDescription');
  }
  if (code === 'PAYMENT_REQUIRED') {
    return i18n.t('agentChat.session.notEnoughCredits');
  }
  return i18n.t('queryError.serverDescription');
}
