import { useQuery } from '@tanstack/react-query';

import { isCloudAgentSessionId, SESSION_COMPUTE_POLL_MS } from '@/lib/session-compute-total';
import { useTRPC } from '@/lib/trpc';
import { isRetryableTrpcError } from '@/lib/trpc-error';

/**
 * The session's recorded compute charges. One request per open session: the
 * header pill and the context sheet read the same query options, so they share
 * one cache entry instead of asking twice.
 *
 * The read polls on a timer for as long as a surface showing it is mounted,
 * which is what the web session information dialog does while it is open. The
 * amount can change under a cached payload at any time — a run that started
 * after an idle read, a run read before its first charged segment exists, a
 * sibling chat's run in the same workspace — and React Native hands this query
 * no focus event to re-trigger it with. Only one caller asks for the poll; the
 * others read the cache entry it keeps fresh.
 *
 * A session with no reachable compute scope answers `FORBIDDEN`; callers treat
 * that as "this session has nothing to show" rather than as a failure, and the
 * poll stops with it: a verdict that a retry cannot change is one the sheet
 * should not ask for every interval. A session whose id the compute routers
 * could not accept is never polled at all.
 */
export function useSessionComputeCharges({
  cloudAgentSessionId,
  organizationId,
  poll = true,
}: {
  cloudAgentSessionId: string | null | undefined;
  organizationId: string | undefined;
  /** Whether this caller owns the shared read's timer. */
  poll?: boolean;
}) {
  const trpc = useTRPC();
  const addressable = isCloudAgentSessionId(cloudAgentSessionId);
  return useQuery(
    trpc.computeBilling.sessionCharges.queryOptions(
      { cloudAgentSessionId: cloudAgentSessionId ?? '', organizationId },
      {
        enabled: addressable,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        refetchInterval: query =>
          poll && addressable && isRetryableTrpcError(query.state.error)
            ? SESSION_COMPUTE_POLL_MS
            : false,
      }
    )
  );
}

/**
 * The current per-hour compute rates. The catalogue changes on a deploy, not
 * during a session, so it is read once and reused.
 */
export function useComputeRates({ enabled }: { enabled: boolean }) {
  const trpc = useTRPC();
  return useQuery(
    trpc.computeBilling.rates.queryOptions(undefined, {
      enabled,
      staleTime: 5 * 60_000,
    })
  );
}
