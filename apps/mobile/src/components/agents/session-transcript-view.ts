import { type OlderMessagesError } from '@kilocode/cloud-agent-sdk';

type SessionTranscriptViewInput = {
  /** Items the merged transcript would render (`mergeSessionTranscript` output length). */
  transcriptItemCount: number;
  hasStatusIndicator: boolean;
  hasOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
};

/**
 * Which body state the session screen renders. `list` mounts the transcript
 * list; the others are the defined non-list states.
 */
type SessionTranscriptView = 'list' | 'status' | 'older-loading' | 'older-error' | 'empty';

/**
 * The transcript list must never mount with zero items: a zero-item FlashList
 * paints blank dead space with no loading indicator and no empty state under a
 * populated session title (mobile-app spot check, e2-open). `mergeSessionTranscript`
 * drops stored messages whose parts render no content, so the branch reads the
 * merged item count, not the stored-message count.
 *
 * A zero-item transcript with a live older-page cursor is a transient loading
 * state (the newest page rendered nothing; older pages may carry content), so
 * it reserves the skeleton and the host pages until the cursor ends or an
 * error lands. A retryable older-page error keeps its own view instead of
 * collapsing into the empty state: the history load can be reattempted, so
 * the body carries a working Retry (mobile-app gate r3, session-transcript-view
 * finding). A terminal older-page error (`invalid_data`/`too_large`) is not
 * retried here: the empty state with the composer is the actionable surface.
 */
export function resolveSessionTranscriptView({
  transcriptItemCount,
  hasStatusIndicator,
  hasOlderMessages,
  olderMessagesError,
}: SessionTranscriptViewInput): SessionTranscriptView {
  if (transcriptItemCount > 0) {
    return 'list';
  }
  if (hasStatusIndicator) {
    return 'status';
  }
  if (hasOlderMessages && olderMessagesError === null) {
    return 'older-loading';
  }
  if (olderMessagesError?.kind === 'retryable') {
    return 'older-error';
  }
  return 'empty';
}
