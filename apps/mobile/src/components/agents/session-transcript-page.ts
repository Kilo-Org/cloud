import {
  type KiloSessionId,
  type KiloSdkMessageHistoryPage,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';
import { trpcClient } from '@/lib/trpc';

/** Shared by the overlay read and the gesture-start prefetch, so a reopen paints from cache. */
export const SESSION_TRANSCRIPT_QUERY_KEY = 'session-transcript-page';

/**
 * Read the newest page of a session's transcript through the access-checked,
 * paged worker read (`cliSessionsV2.getSessionMessagesPage`).
 *
 * The long-press preview and its prefetch used to read
 * `cliSessionsV2.getSessionMessages`, which asks the session-ingest worker for
 * the whole session in one unbounded response. For a long session that read
 * exceeds the control plane's upstream budget and fails with `500`
 * (KILOCODE-WEB-285J, KILO-APP-39W). The preview is a bounded newest-first
 * view, so one page is enough and never times out. The paged route keeps the
 * same access checks, so a foreign or missing session still rejects with
 * `NOT_FOUND` and the preview keeps its permission and error states.
 */
export async function fetchNewestSessionTranscript(
  kiloSessionId: KiloSessionId
): Promise<readonly StoredMessage[]> {
  const result = await trpcClient.cliSessionsV2.getSessionMessagesPage.query({
    session_id: kiloSessionId,
  });
  const history = result.history;
  if (history === null) {
    return [];
  }
  if ('messages' in history) {
    return (history as KiloSdkMessageHistoryPage).messages as readonly StoredMessage[];
  }
  // A typed worker failure is not a page: the preview must show its error
  // state instead of an empty transcript.
  throw new Error(
    history.kind === 'retryable_failure'
      ? 'Session messages temporarily unavailable'
      : history.kind === 'too_large'
        ? 'Session messages too large to load'
        : 'Session messages are unavailable'
  );
}

/** The overlay read and the gesture-start prefetch share this one key. */
export function sessionTranscriptQueryOptions(kiloSessionId: KiloSessionId) {
  return {
    queryKey: [SESSION_TRANSCRIPT_QUERY_KEY, kiloSessionId] as const,
    queryFn: () => fetchNewestSessionTranscript(kiloSessionId),
  };
}
