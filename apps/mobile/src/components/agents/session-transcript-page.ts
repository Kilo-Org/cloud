import { type KiloSessionId, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import {
  fetchMobileSessionSnapshotPage,
  SESSION_HISTORY_FAILURES,
  SessionHistoryFailureError,
} from './mobile-session-page-adapter';

/** Shared by the overlay read and the gesture-start prefetch, so a reopen paints from cache. */
const SESSION_TRANSCRIPT_QUERY_KEY = 'session-transcript-page';

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
 *
 * `sessionId` is the row's id, which the tRPC input schema accepts as a plain
 * string; only the paged read itself needs the SDK's branded id.
 */
async function fetchNewestSessionTranscript(sessionId: string): Promise<readonly StoredMessage[]> {
  const page = await fetchMobileSessionSnapshotPage(sessionId as KiloSessionId, {});
  if (page.kind !== 'success') {
    // A typed worker failure is not a page: the preview must show its error
    // state instead of an empty transcript.
    throw new SessionHistoryFailureError(SESSION_HISTORY_FAILURES[page.kind]);
  }
  return page.messages;
}

/** The overlay read and the gesture-start prefetch share this one key. */
export function sessionTranscriptQueryOptions(sessionId: string) {
  return {
    queryKey: [SESSION_TRANSCRIPT_QUERY_KEY, sessionId] as const,
    queryFn: fetchNewestSessionTranscript.bind(null, sessionId),
  };
}
