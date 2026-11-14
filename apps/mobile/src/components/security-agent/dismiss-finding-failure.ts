import {
  type SecurityDismissDraft,
  securityDismissFailureCopy,
} from '@/lib/hooks/use-security-dismiss-draft';
import { isSecuritySyncRetryable } from '@/lib/security-agent-ledger';

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
export function resolveDismissFailure(
  mutationError: Error | null,
  draft: SecurityDismissDraft | null
): DismissFailure | null {
  if (mutationError !== null) {
    return {
      kind: isSecuritySyncRetryable(mutationError) ? 'retryable' : 'terminal',
      message: mutationError.message,
    };
  }
  if (draft?.lastError == null) {
    return null;
  }
  return {
    kind: draft.retryable === false ? 'terminal' : 'retryable',
    message: securityDismissFailureCopy(draft),
  };
}
