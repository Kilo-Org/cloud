import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';
import { isCloudAgentSessionId } from '@/lib/session-compute-total';

/**
 * The session's recorded compute charges. One request per open session: the
 * header pill and the context sheet read the same query options, so they share
 * one cache entry instead of asking twice.
 *
 * A session with no reachable compute scope answers `FORBIDDEN`; callers treat
 * that as "this session has nothing to show" rather than as a failure.
 */
export function useSessionComputeCharges({
  cloudAgentSessionId,
  organizationId,
}: {
  cloudAgentSessionId: string | null | undefined;
  organizationId: string | undefined;
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
