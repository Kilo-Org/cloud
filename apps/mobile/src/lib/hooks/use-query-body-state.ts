import { classifyConfigBody, type ConfigBodyState } from '@/lib/code-reviewer-status';
import { useIdleLoadRetry } from '@/lib/hooks/use-idle-load-retry';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';

/** The parts of any read that decide its body surface. */
type QueryBodyRead = {
  /** Only null-ness is read; any settled payload shape works. */
  data: unknown;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => void;
};

export type QueryBodyState = {
  body: ConfigBodyState;
  /** The automatic restart already ran and the read is still not fetching. */
  exhausted: boolean;
  /** Restart the read by hand. */
  retry: () => void;
};

/** The retryable error surface a read's failure needs. */
export type QueryBodyFailure = {
  variant: 'server' | 'offline';
  onRetry: () => void;
  isRetrying: boolean;
};

/**
 * The error surface for a read, or null while the body is drawable.
 *
 * `error` retries the failed read; `exhausted` is a read that stayed pending
 * with nothing in flight even after its one automatic restart, so the action
 * re-arms that restart cycle. A screen's own body switch reads this once and
 * paints a single error shape instead of classifying the read again.
 */
export function queryBodyFailure(
  { body, exhausted, retry }: QueryBodyState,
  isRetrying: boolean
): QueryBodyFailure | null {
  if (body.status === 'error') {
    return { variant: body.variant, onRetry: body.refetch, isRetrying };
  }
  if (exhausted) {
    return { variant: 'server', onRetry: retry, isRetrying };
  }
  return null;
}

/**
 * A read's body surface, with the app's probe-backed connectivity and the
 * restart of a read that nothing is fetching.
 *
 * Every read gets one call site per screen, because every surface must cover
 * all of it: a screen that classified the read itself could (and did) leave
 * the state `pending` + `idle` unhandled and paint its header over an empty
 * body. The reviewer config screens are the largest caller, but a read that is
 * not the reviewer config — the analytics dashboard, the review list — uses
 * the same surface. `restartable: false` is for a screen that renders a child
 * owning the same read, so the read is not restarted twice.
 */
export function useQueryBodyState(
  read: QueryBodyRead,
  { restartable = true }: { restartable?: boolean } = {}
): QueryBodyState {
  // A successful probe can confirm online while NetInfo still pauses queries.
  const connectivityKnown = useCommittedConnectivityStatus() !== 'unknown';
  const body = classifyConfigBody({
    hasData: read.data != null,
    isError: read.isError,
    isFetching: read.isFetching,
    fetchStatus: read.fetchStatus,
    connectivityKnown,
    refetch: () => {
      read.refetch();
    },
  });
  const idleRetry = useIdleLoadRetry({
    idle: restartable && body.status === 'loading' && body.idle,
    refetch: () => {
      read.refetch();
    },
  });
  return { body, exhausted: idleRetry.exhausted, retry: idleRetry.retry };
}
