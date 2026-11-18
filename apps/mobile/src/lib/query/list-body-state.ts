/**
 * Which body a list backed by one React Query read renders.
 *
 * - `rows`: rows are on screen (also during a background refetch, and when a
 *   later page failed — its footer owns Retry).
 * - `loading`: a first read that is in flight, never started, or paused while
 *   the app has not settled whether it is offline.
 * - `error`: a read that failed without rows to show, or one paused by a
 *   connection the app has confirmed is down, so Retry is the useful action.
 * - `empty`: the read delivered and had nothing to show. Nothing else may
 *   claim the list is empty: a read that never delivered, or whose cached rows
 *   were cleared, has not answered the question.
 *
 * The two error causes stay distinct because the connection wording is the
 * app's (`queryError.offlineTitle`), while a failed read is the caller's own
 * failure copy.
 */
export type ListBody =
  | { status: 'rows' }
  | { status: 'loading' }
  | { status: 'error'; cause: 'failed' | 'offline'; isRetrying: boolean }
  | { status: 'empty' };

export function classifyListBody(input: {
  /** Rows the list would render from delivered data. */
  rowCount: number;
  /**
   * Whether the read has delivered. For an infinite query that is at least one
   * delivered page: a reset cache holds zero pages and has delivered nothing.
   */
  hasDeliveredData: boolean;
  /** A later page (or another part of the list) failed and renders its own Retry. */
  hasInlineError?: boolean;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  /** False while the app's probe-backed connectivity is still `unknown`. */
  connectivityKnown: boolean;
}): ListBody {
  if (input.hasInlineError === true) {
    return { status: 'rows' };
  }
  if (input.rowCount > 0) {
    return { status: 'rows' };
  }
  if (input.isError) {
    return { status: 'error', cause: 'failed', isRetrying: input.isFetching };
  }
  if (input.hasDeliveredData) {
    return { status: 'empty' };
  }
  if (input.fetchStatus === 'paused' && input.connectivityKnown) {
    return { status: 'error', cause: 'offline', isRetrying: input.isFetching };
  }
  return { status: 'loading' };
}
