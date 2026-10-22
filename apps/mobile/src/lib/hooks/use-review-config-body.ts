import { type ReviewConfigData } from '@/lib/code-reviewer-config';
import { classifyConfigBody, type ConfigBodyState } from '@/lib/code-reviewer-status';
import { useIdleLoadRetry } from '@/lib/hooks/use-idle-load-retry';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';

/** The parts of the reviewer config read that decide its body surface. */
type ReviewConfigRead = {
  data: ReviewConfigData | undefined | null;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => void;
};

export type ReviewConfigBody = {
  body: ConfigBodyState;
  /** The automatic restart already ran and the read is still not fetching. */
  exhausted: boolean;
  /** Restart the read by hand. */
  retry: () => void;
};

/**
 * The reviewer config read's body surface, with the app's probe-backed
 * connectivity and the restart of a read that nothing is fetching.
 *
 * One call site per screen, because every surface must cover all of it: a
 * screen that classified the read itself could (and did) leave the state
 * `pending` + `idle` unhandled and paint its header over an empty body.
 * `restartable: false` is for a screen that renders a child owning the same
 * read, so the read is not restarted twice.
 */
export function useReviewConfigBody(
  config: ReviewConfigRead,
  { restartable = true }: { restartable?: boolean } = {}
): ReviewConfigBody {
  // A successful probe can confirm online while NetInfo still pauses queries.
  const connectivityKnown = useCommittedConnectivityStatus() !== 'unknown';
  const body = classifyConfigBody({
    hasData: config.data != null,
    isError: config.isError,
    isFetching: config.isFetching,
    fetchStatus: config.fetchStatus,
    connectivityKnown,
    refetch: () => {
      config.refetch();
    },
  });
  const idleRetry = useIdleLoadRetry({
    idle: restartable && body.status === 'loading' && body.idle,
    refetch: () => {
      config.refetch();
    },
  });
  return { body, exhausted: idleRetry.exhausted, retry: idleRetry.retry };
}
