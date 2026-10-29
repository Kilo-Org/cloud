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
import {
  isOperationInProgress,
  OPERATION_KEY_REUSE_MISMATCH_MESSAGE,
} from '@/lib/operation-markers';
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
// The server provably never reached the security Worker: nothing was enqueued,
// so the intent is over even though a later attempt can succeed.
export const SECURITY_SERVICE_UNAVAILABLE_MESSAGE = 'Security service is unavailable';

/** Which security surface renders a mapped error; the in-progress copy differs. */
type SecurityErrorSurface = 'sync' | 'dismiss';

/**
 * A ledger error re-wrapped for display. The retryability and key-retention
 * decisions travel on the error, not in its text, so the surfaces can still
 * decide whether the operation key survives after the message is translated.
 * `copyKey` names the catalog key the message was translated from (null for an
 * unrecognised message), so a surface that persists the failure — the durable
 * dismiss draft — can store the key and re-translate at render instead of
 * freezing one language's sentence.
 */
type SecurityMutationErrorOptions = {
  /** The copy's catalog key, or null when the message is not catalog copy. */
  copyKey: string | null;
  /** The retryability decision taken from the raw error before mapping. */
  retryable: boolean;
  /** The key-retention decision taken from the raw error before mapping. */
  retainsOperationKey: boolean;
  /** The raw server error, kept for the app-error reporter's skip rule. */
  cause: unknown;
};

class SecurityMutationError extends Error {
  readonly retryable: boolean;
  readonly copyKey: string | null;
  readonly retainsOperationKey: boolean;

  constructor(message: string, options: SecurityMutationErrorOptions) {
    super(message, { cause: options.cause });
    this.retryable = options.retryable;
    this.copyKey = options.copyKey;
    this.retainsOperationKey = options.retainsOperationKey;
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
 * True when a retry of the action can succeed, which is what the surfaces use
 * to keep their retry affordance. Also used for finding dismissal, which shares
 * the ledger markers.
 *
 * This is the "may I try again" question, not the "may I reuse the key" one:
 * see `securityRetainsOperationKey` for the latter.
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
      error.message === SECURITY_LEDGER_SETTLE_FAILED_MESSAGE ||
      error.message === SECURITY_SERVICE_UNAVAILABLE_MESSAGE
    ) {
      return true;
    }
  }
  return classifyPrReviewMutationError(error).kind === 'retryable';
}

/**
 * Whether a retry reuses the operation key. Two different questions a failure
 * answers: can a retry succeed (`isSecuritySyncRetryable`), and is the key
 * still the intent's. A definitive pre-acceptance rejection settles the ledger
 * row, so its key can never be replayed — even when the retry itself is
 * expected to succeed, as with an unreachable Worker it is a fresh intent.
 */
export function securityRetainsOperationKey(error: unknown): boolean {
  if (error instanceof SecurityMutationError) {
    return error.retainsOperationKey;
  }
  return (
    isSecuritySyncRetryable(error) &&
    !(error instanceof Error && error.message === SECURITY_SERVICE_UNAVAILABLE_MESSAGE)
  );
}

/** The catalog key each known server marker's copy comes from, or null. */
function markerKeyFor(error: Error): string | null {
  switch (error.message) {
    case SECURITY_AMBIGUOUS_MESSAGE: {
      return 'securityAgent.mutations.ambiguous';
    }
    case SECURITY_LEDGER_SETTLE_FAILED_MESSAGE: {
      return 'securityAgent.mutations.settleFailed';
    }
    case SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE: {
      return 'common.actionNotRecorded';
    }
    case SECURITY_OPERATION_REPLAY_FAILED_MESSAGE: {
      return 'securityAgent.mutations.replayFailed';
    }
    case SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE: {
      return 'securityAgent.mutations.serviceNotConfiguredResubmit';
    }
    case SECURITY_SERVICE_UNAVAILABLE_MESSAGE: {
      return 'securityAgent.mutations.serviceUnavailable';
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
const IN_PROGRESS_KEY_BY_SURFACE = {
  sync: 'securityAgent.mutations.syncInProgress',
  dismiss: 'securityAgent.mutations.dismissalInProgress',
} as const satisfies Record<SecurityErrorSurface, string>;

/**
 * The fallback key for a failure the mapper does not recognise. The terminal
 * class gets its own sentence: its controls stay down, so the copy must not
 * tell the reader to try again.
 */
function fallbackKeyFor(retryable: boolean): string {
  return retryable
    ? 'securityAgent.mutations.actionFailed'
    : 'securityAgent.mutations.actionBlocked';
}

function mapSecurityOperationError(error: unknown, surface: SecurityErrorSurface): Error {
  const retryable = isSecuritySyncRetryable(error);
  const retainsOperationKey = securityRetainsOperationKey(error);
  const markerKey = error instanceof Error ? markerKeyFor(error) : null;
  const fallbackKey = isOperationInProgress(error)
    ? IN_PROGRESS_KEY_BY_SURFACE[surface]
    : fallbackKeyFor(retryable);
  const copyKey = markerKey ?? fallbackKey;
  return new SecurityMutationError(i18n.t(copyKey), {
    copyKey,
    retryable,
    retainsOperationKey,
    cause: error,
  });
}

/**
 * The catalog key a security failure's surface copy comes from: the mapped
 * error's own key, or the same classification a fresh mapping would apply. A
 * surface that persists the failure (the durable dismiss draft) stores this key
 * and re-translates at render, so the stored failure never freezes one
 * language's sentence. Returns null for a message the mapper does not
 * recognise: the stored English sentence renders verbatim there.
 */
export function securityMutationCopyKey(error: unknown): string | null {
  if (error instanceof SecurityMutationError) {
    return error.copyKey;
  }
  if (error instanceof Error) {
    const markerKey = markerKeyFor(error);
    if (markerKey !== null) {
      return markerKey;
    }
  }
  if (isOperationInProgress(error)) {
    return IN_PROGRESS_KEY_BY_SURFACE.dismiss;
  }
  return fallbackKeyFor(isSecuritySyncRetryable(error));
}

/**
 * The localized copy for a known server marker, for the surfaces that show the
 * server's own sentence otherwise (the analysis and remediation toasts). Null
 * for an unrecognised message, so the caller keeps the server's text.
 */
export function localizedSecurityMarkerMessage(error: unknown): string | null {
  const markerKey = error instanceof Error ? markerKeyFor(error) : null;
  return markerKey === null ? null : i18n.t(markerKey);
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
