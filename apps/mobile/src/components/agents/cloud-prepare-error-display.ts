// Pure selection of the inline / toast copy for a failed cloud `prepareSession`
// (new-session form, Continue clone, and the OS start action's shared core).
// Classification lives in `isCloudPrepareRetryableError` (retry semantics) —
// this helper only picks the localized message, so the raw server string never
// reaches the UI. Known failure classes map to actionable copy; everything
// else, including an unclassified BAD_REQUEST detail, gets the localized
// generic line.

import { i18n } from '@/i18n';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** The server's denial message for an organization the caller cannot use. */
const ORGANIZATION_ACCESS_MESSAGE = 'You do not have access to this organization';

/** The worker's unavailable-model rejection, mapped to the model picker copy. */
const MODEL_UNAVAILABLE_MESSAGE = 'Selected model is not available for this cloud agent session';

/**
 * The localized failure copy for a rejected cloud prepare. Only failures the
 * message names precisely get actionable copy; every other rejection — an
 * unclassified server detail, an unknown transport failure — gets the generic
 * service line, because the tRPC code alone does not identify the failure.
 */
export function cloudPrepareFailureMessage(error: unknown): string {
  const message = readTrpcErrorField(error, 'message');
  if (message === ORGANIZATION_ACCESS_MESSAGE) {
    return i18n.t('agentChat.newSession.checkOrganizationAccess');
  }
  if (message === MODEL_UNAVAILABLE_MESSAGE) {
    return i18n.t('agentChat.session.modelUnavailable');
  }
  if (readTrpcErrorField(error, 'code') === 'PAYMENT_REQUIRED') {
    return i18n.t('agentChat.session.notEnoughCredits');
  }
  return i18n.t('queryError.serverDescription');
}
