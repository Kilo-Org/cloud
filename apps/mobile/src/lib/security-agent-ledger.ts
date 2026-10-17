// Security operation-ledger markers (P1-A-08e), mirrored from the server's
// `shared-handlers.ts`. The server sends English markers; the mapping here
// replaces them with catalog copy before the error reaches a surface, so the
// dashboard banner, the failure toast, and the dismiss sheet all read the
// reader's language. The raw marker stays on the mapped error's `cause`, and
// the retryability decision is carried on the error itself so a translated
// message still drives the key-rotation and disabled-control contracts.
//
// The same pattern as `@/lib/pr-review/merge/pr-operation-ledger`, which maps
// the PR surface's share of these markers.

import { i18n } from '@/i18n';
import { isOperationInProgress, OPERATION_KEY_REUSE_MISMATCH_MESSAGE } from '@/lib/operation-key';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';

/** A settled `failed` row replayed under the same key: no recovery, fresh key. */
export const SECURITY_OPERATION_REPLAY_FAILED_MESSAGE =
  'This action did not complete. Please try again.';
// Ambiguous transport outcome: the Worker may have accepted the command, so the
// server reconciles a same-key retry instead of re-submitting blind.
export const SECURITY_AMBIGUOUS_MESSAGE =
  "Couldn't confirm — check the security review before retrying.";
// Confirmed outcome whose settle failed: a same-key retry re-records it.
export const SECURITY_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';
// The ambiguous outcome could not be recorded as reconcile-pending, so the
// same-key retry guarantee does not hold; the next submit needs a fresh key.
export const SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE =
  'We could not record this action. Please try again later.';
// The manual-sync Worker URL or internal secret is unset server-side, so no
// resubmit can succeed until the deployment is reconfigured.
export const SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE = 'Security service is not configured';

/** Which security surface renders a mapped error; the in-progress copy differs. */
type SecurityErrorSurface = 'sync' | 'dismiss';

/**
 * A ledger error re-wrapped for display. The retryability travels on the error,
 * not in its text, so the surfaces can still decide whether the operation key
 * survives after the message is translated.
 */
class SecurityMutationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, cause: unknown) {
    super(message, { cause });
    this.retryable = retryable;
  }
}

/**
 * Card copy for a reconcile-first sync row: a crash mid-sync left the outcome
 * uncertain, so the card offers a same-key reconcile retry instead of a blind
 * re-POST.
 */
export function securitySyncReconcileCopy(): string {
  return i18n.t('securityAgent.mutations.syncMayNotHaveCompleted');
}

/**
 * True when the mutation may be retried under the SAME operation key. Also
 * used for finding dismissal, which shares the ledger markers.
 */
export function isSecuritySyncRetryable(error: unknown): boolean {
  if (error instanceof SecurityMutationError) {
    return error.retryable;
  }
  if (error instanceof Error) {
    if (error.message === SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE) {
      return false;
    }
    if (error.message === OPERATION_KEY_REUSE_MISMATCH_MESSAGE) {
      return false;
    }
    if (error.message === SECURITY_OPERATION_REPLAY_FAILED_MESSAGE) {
      return false;
    }
    if (error.message === SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE) {
      return false;
    }
    if (
      error.message === SECURITY_AMBIGUOUS_MESSAGE ||
      error.message === SECURITY_LEDGER_SETTLE_FAILED_MESSAGE
    ) {
      return true;
    }
  }
  return classifyPrReviewMutationError(error).kind === 'retryable';
}

/** The catalog copy for a known server marker, or null for any other message. */
function ledgerMarkerCopy(error: Error): string | null {
  switch (error.message) {
    case SECURITY_AMBIGUOUS_MESSAGE: {
      return i18n.t('securityAgent.mutations.ambiguous');
    }
    case SECURITY_LEDGER_SETTLE_FAILED_MESSAGE: {
      return i18n.t('securityAgent.mutations.settleFailed');
    }
    case SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE: {
      return i18n.t('common.actionNotRecorded');
    }
    case SECURITY_OPERATION_REPLAY_FAILED_MESSAGE: {
      return i18n.t('securityAgent.mutations.replayFailed');
    }
    case SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE: {
      return i18n.t('securityAgent.mutations.serviceNotConfiguredResubmit');
    }
    default: {
      return null;
    }
  }
}

/**
 * Maps any failure onto the copy its surface shows. A known marker keeps its
 * exact catalog sentence; the in-progress duplicate keeps the surface's copy;
 * everything else reads one localized fallback sentence, because the server's
 * own English explanation cannot be translated on the device. The fallback
 * follows the retry class a terminal rejection gets: its controls stay down,
 * so the copy must not tell the reader to try again. Retryability is decided
 * from the raw error before its message is replaced.
 */
function mapSecurityOperationError(error: unknown, surface: SecurityErrorSurface): Error {
  const retryable = isSecuritySyncRetryable(error);
  const marker = error instanceof Error ? ledgerMarkerCopy(error) : null;
  const inProgress = isOperationInProgress(error);
  const fallback = inProgress
    ? i18n.t(
        surface === 'sync'
          ? 'securityAgent.mutations.syncInProgress'
          : 'securityAgent.mutations.dismissalInProgress'
      )
    : i18n.t(
        retryable ? 'securityAgent.mutations.actionFailed' : 'securityAgent.mutations.actionBlocked'
      );
  return new SecurityMutationError(marker ?? fallback, retryable, error);
}

/** Maps a sync failure onto retryable or terminal security copy. */
export function mapSecuritySyncOperationError(error: unknown): Error {
  return mapSecurityOperationError(error, 'sync');
}

/** Same markers, dismissal copy: the dismiss sheet must not talk about a sync. */
export function mapSecurityDismissOperationError(error: unknown): Error {
  return mapSecurityOperationError(error, 'dismiss');
}

/** Intent fingerprint for a manual sync: a changed scope or repo is a new intent. */
export function securitySyncIntentFingerprint(scope: string, repoFullName?: string): string {
  return JSON.stringify({ resource: [scope], repoFullName });
}
