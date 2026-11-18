/**
 * The pure predicate driving the TanStack Query `retry` callback for the
 * `cliSessionsV2.get` read on the `/(app)/agent-chat/[session-id]` route.
 *
 * The ingest row is written by the parent's own
 * `Session.Event.Created` -> `IngestQueue` flow, which is NOT synchronous
 * with the mobile client's read. Without a short retry, the very first
 * query tick after navigation lands on a row that hasn't been ingested
 * yet, surfaces a transient `NOT_FOUND`, and the user sees a permanent
 * "session not found" screen for a session that genuinely exists. Child
 * boot time does not widen this window (the parent pre-creates the row
 * itself, independent of when the CLI child actually attaches), so 8
 * attempts at ~1s is generous.
 *
 * Every open runs that budget: a session-row tap, a link, an app action, a
 * notification, and the `spawned=1` route the `kilo remote` flow creates. It
 * is not withdrawn for an open that began on the identity restored from
 * storage either — that is the state every cold start is in before
 * `user.getMe` confirms, and it is where the read most needs the window.
 * What must stay immediate is the account boundary, and that boundary is an
 * access denial (`UNAUTHORIZED`/`FORBIDDEN`), which this predicate never
 * retries.
 *
 * A stale or deleted session reaches the same terminal "not found" state
 * once the window closes; that state offers no Retry, because the read has
 * already had its whole chance to settle.
 *
 * Implemented as a free function (not a method on the route component) so it
 * can be unit-tested in a plain Node vitest environment without rendering the
 * screen or mocking the router.
 */
export const SPAWNED_NOT_FOUND_MAX_ATTEMPTS = 8;

/**
 * Whether one failed `cliSessionsV2.get` attempt may be repeated. Only
 * `NOT_FOUND` is retried, and only within the shared attempt ceiling; every
 * other code returns false, so the route's own terminal handling owns it.
 */
export function shouldRetrySessionNotFound({
  attempt,
  errorCode,
}: {
  /** 0-indexed attempt count from TanStack Query's `retry(failureCount)`. */
  attempt: number;
  /** The structured tRPC error code, if any. */
  errorCode: string | undefined;
}): boolean {
  if (errorCode !== 'NOT_FOUND') {
    return false;
  }
  return attempt < SPAWNED_NOT_FOUND_MAX_ATTEMPTS;
}
