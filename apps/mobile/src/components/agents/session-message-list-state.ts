import { type OlderMessagesError } from 'cloud-agent-sdk';

/**
 * Pagination header state for `SessionMessageList`. The component renders
 * exactly one of these per render: a loading skeleton, a calm inline
 * message (with or without a Retry CTA), or nothing.
 *
 * Priority is enforced by `selectSessionMessageListHeaderState`:
 *   1. The most recent typed failure wins so the user can always act on it
 *      (or, for non-retryable terminals, sees a stable final message).
 *   2. While a page is loading, the skeleton replaces the omitted message
 *      so the two never collide visually.
 *   3. The omitted-item count only surfaces when the load path is healthy.
 */
type SessionMessageListHeaderState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'retryable' }
  | { kind: 'invalid_data' }
  | { kind: 'too_large' }
  | { kind: 'omitted'; count: number };

export type SessionMessageListHeaderStateInputs = {
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  olderMessagesOmittedItemCount: number;
};

export function selectSessionMessageListHeaderState({
  isLoadingOlderMessages,
  olderMessagesError,
  olderMessagesOmittedItemCount,
}: SessionMessageListHeaderStateInputs): SessionMessageListHeaderState {
  if (olderMessagesError) {
    if (olderMessagesError.kind === 'retryable') {
      return { kind: 'retryable' };
    }
    if (olderMessagesError.kind === 'invalid_data') {
      return { kind: 'invalid_data' };
    }
    return { kind: 'too_large' };
  }
  if (isLoadingOlderMessages) {
    return { kind: 'loading' };
  }
  if (olderMessagesOmittedItemCount > 0) {
    return { kind: 'omitted', count: olderMessagesOmittedItemCount };
  }
  return { kind: 'hidden' };
}

type ShouldTriggerOlderMessagesLoadInputs = {
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  isInFlight: boolean;
  olderMessagesError: OlderMessagesError | null;
};

/**
 * Decide whether `onStartReached` should trigger an older-page load.
 *
 * The guard is intentionally conservative: it blocks the call when there is no
 * older cursor, when a page is already loading, when the component's local
 * in-flight latch is still set, or when the most recent failure is a
 * non-retryable terminal state. Retryable failures are allowed to re-fire so
 * the FlashList gesture can retry without requiring an explicit tap on the
 * Retry CTA.
 */
export function shouldTriggerOlderMessagesLoad({
  hasOlderMessages,
  isLoadingOlderMessages,
  isInFlight,
  olderMessagesError,
}: ShouldTriggerOlderMessagesLoadInputs): boolean {
  if (!hasOlderMessages) {
    return false;
  }
  if (isLoadingOlderMessages) {
    return false;
  }
  if (isInFlight) {
    return false;
  }
  if (olderMessagesError && olderMessagesError.kind !== 'retryable') {
    return false;
  }
  return true;
}
