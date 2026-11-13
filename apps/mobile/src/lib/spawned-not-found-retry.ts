/**
 * Pure predicates driving the TanStack Query `retry` callback for the
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
 * Two entry points share that budget:
 *
 * - `shouldRetryNotFoundOnSpawnedRoute` gates the `spawned=1` param (the
 *   `kilo remote` happy path) on its own.
 * - `shouldRetryNotFoundOnYoungRoute` extends the same window to every
 *   other navigation into the route.
 * - `shouldRetrySessionNotFound` is what the route hands to Query: it picks
 *   the entry point for the open, and every open — including one that began
 *   on the identity restored from storage — gets the budget.
 *
 * A stale or deleted session reaches the same terminal "not found" state
 * once the window closes; that state offers no Retry, because the read has
 * already had its whole chance to settle.
 *
 * Implemented as free functions (not methods on the route component) so
 * they can be unit-tested in a plain Node vitest environment without
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

/**
 * The same NOT_FOUND retry budget for every OTHER navigation into this route:
 * session-row pushes, deep links, app actions, and notification opens. The
 * parent ingest write is not synchronous with any of those reads either — the
 * session-detail surface answers a first-tick `NOT_FOUND` for a session that
 * genuinely exists with a permanent, no-retry screen. The same 8×1s budget
 * the spawned path uses bounds the wait; a stale or deleted session still
 * reaches the permanent state after the window closes.
 *
 * Non-NOT_FOUND codes and retries beyond the budget return false, so the
 * route's own terminal handling owns everything else.
 */
export function shouldRetryNotFoundOnYoungRoute({
  attempt,
  errorCode,
}: {
  attempt: number;
  errorCode: string | undefined;
}): boolean {
  if (errorCode !== 'NOT_FOUND') {
    return false;
  }
  return attempt < SPAWNED_NOT_FOUND_MAX_ATTEMPTS;
}

/**
 * The single decision the route hands to TanStack Query: whether one failed
 * `cliSessionsV2.get` attempt may be repeated.
 *
 * `NOT_FOUND` is never proof that the session is gone. The row can lag the
 * client's read, and every open runs the same 8×1s budget whoever started it —
 * a session-row tap, a link, an app action, a notification, the spawn's own
 * route, and an open that began on the identity restored from storage. That
 * last case used to be denied the budget: one unsettled read at a cold start
 * painted the terminal not-found body for a session the account still listed.
 * The denial the skip was meant to protect is an access boundary, and an access
 * boundary is `UNAUTHORIZED`/`FORBIDDEN`, which this predicate never retries —
 * so the boundary stays immediate without the skip.
 *
 * Codes other than `NOT_FOUND` return false, so the route's own terminal
 * handling owns them.
 */
export function shouldRetrySessionNotFound({
  spawned,
  attempt,
  errorCode,
}: {
  /** The `spawned` route param, if any. */
  spawned: string | undefined;
  /** 0-indexed attempt count from TanStack Query's `retry(failureCount)`. */
  attempt: number;
  /** The structured tRPC error code, if any. */
  errorCode: string | undefined;
}): boolean {
  if (spawned !== undefined) {
    return shouldRetryNotFoundOnSpawnedRoute({ spawned, attempt, errorCode });
  }
  return shouldRetryNotFoundOnYoungRoute({ attempt, errorCode });
}
