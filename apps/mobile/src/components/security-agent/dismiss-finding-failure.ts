import { i18n } from '@/i18n';
import {
  type SecurityDismissDraft,
  securityDismissFailureCopy,
} from '@/lib/hooks/use-security-dismiss-draft';
import {
  isSecuritySyncRetryable,
  isSecurityTrialRefusal,
  SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE,
  SECURITY_OPERATION_REPLAY_FAILED_MESSAGE,
} from '@/lib/security-agent-ledger';
import { trialRefusalCopyKey } from '@/lib/trial-refusal-copy';

/** Why the dismissal did not go through, and whether the same intent may be retried. */
export type DismissFailure =
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'terminal'; readonly message: string };

/**
 * The one failure a dismissal form shows. Two owners hold it — the live mutation
 * and the durable draft that survives the screen — and they describe the same
 * episode: a rejection recorded before a command id exists is only in the draft,
 * so a reopened sheet must read it to keep a terminal CTA down.
 */
/**
 * Whether the ledger marker's own copy asks the reader to try again. Both
 * markers end the *same* operation key (`securityRetainsOperationKey` rotates
 * it), so a fresh submit is a new intent — and their copy says "try again", so
 * the terminal kind would disable the only control that can.
 */
function markerInvitesRetry(message: string): boolean {
  return (
    message === SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE ||
    message === SECURITY_OPERATION_REPLAY_FAILED_MESSAGE
  );
}

/** Retryability for the dismissal form: the sync classification, plus the retry-inviting ledger markers. */
export function isDismissFailureRetryable(error: unknown): boolean {
  if (error instanceof Error && markerInvitesRetry(error.message)) {
    return true;
  }
  return isSecuritySyncRetryable(error);
}

/**
 * The failure the sheet shows, from the live mutation error or the draft that
 * outlives it. Both re-translate a trial refusal for the reader rendering it,
 * so `canManageBilling` must be the caller's own role answer — the same value
 * that decides whether the trial refusal's step is offered under the sentence.
 */
export function resolveDismissFailure(
  mutationError: Error | null,
  draft: SecurityDismissDraft | null,
  canManageBilling: boolean
): DismissFailure | null {
  if (mutationError !== null) {
    return {
      kind: isDismissFailureRetryable(mutationError) ? 'retryable' : 'terminal',
      // A refusal mapped before the membership list settled carries the
      // rejection-time sentence; re-translate it for this reader, as the draft
      // branch does, so the sentence and the step under it describe one role.
      message: isSecurityTrialRefusal(mutationError)
        ? i18n.t(trialRefusalCopyKey(canManageBilling))
        : mutationError.message,
    };
  }
  if (draft?.lastError == null) {
    return null;
  }
  // A draft written before this rule can still carry `retryable: false` for a
  // marker whose copy invites the retry; read the stored message too.
  const terminal = draft.retryable === false && !markerInvitesRetry(draft.lastError);
  return {
    kind: terminal ? 'terminal' : 'retryable',
    // The draft names the refusal, so the sentence is painted for this reader
    // from the same role answer that decides the step below it.
    message: securityDismissFailureCopy(draft, canManageBilling),
  };
}
