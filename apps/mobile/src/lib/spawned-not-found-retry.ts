/**
 * Pure predicate driving the TanStack Query `retry` callback for the
 * `cliSessionsV2.get` read on the `/(app)/agent-chat/[session-id]` route.
 *
 * The retry only matters for the freshly-spawned `kilo remote` happy path:
 * the parent ingest row is written by the parent's own
 * `Session.Event.Created` -> `IngestQueue` flow, which is NOT synchronous
 * with the mobile client's read. Without a short retry, the very first
 * query tick after `router.replace` lands on a row that hasn't been
 * ingested yet, surfaces a transient `NOT_FOUND`, and the user sees a
 * permanent "session not found" screen for a session that genuinely
 * exists. Child boot time does not widen this window (the parent
 * pre-creates the row itself, independent of when the CLI child
 * actually attaches), so 8 attempts at ~1s is generous.
 *
 * Without the `spawned=1` route param, behavior is byte-identical to the
 * pre-C3b contract: `retry: false` everywhere. This guard keeps a
 * stale/deleted session in the user's history showing the same permanent
 * "not found" state it always did.
 *
 * Implemented as a free function (not a method on the route component) so
 * it can be unit-tested in a plain Node vitest environment without
 * rendering the screen or mocking the router.
 */
export const SPAWNED_NOT_FOUND_MAX_ATTEMPTS = 8;

export function shouldRetryNotFoundOnSpawnedRoute({
  spawned,
  attempt,
  errorCode,
}: {
  /**
   * The `spawned` route param, if any. `undefined` (absent) means the
   * caller navigated here through any other path (push, deep link, tab
   * tap, etc.) and must not get the spawned-row retry.
   */
  spawned: string | undefined;
  /**
   * 0-indexed attempt count from TanStack Query's `retry(failureCount)`
   * callback. `attempt === 0` means the first failure (the very first
   * request returned an error).
   */
  attempt: number;
  /**
   * The structured tRPC error code, if any. `NOT_FOUND` is the only
   * error this helper retries; any other code is the route's problem to
   * surface (transient, retriable by the existing QueryError UI for
   * non-`NOT_FOUND`).
   */
  errorCode: string | undefined;
}): boolean {
  if (spawned === undefined) {
    return false;
  }
  if (errorCode !== 'NOT_FOUND') {
    return false;
  }
  return attempt < SPAWNED_NOT_FOUND_MAX_ATTEMPTS;
}
