import { useQuery } from '@tanstack/react-query';

import {
  type CloudAgentEligibilityQuery,
  type CloudAgentEligibilityState,
  resolveCloudAgentEligibilityState,
} from '@/lib/cloud-agent-eligibility';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

export type CloudAgentEligibilityRead = {
  state: CloudAgentEligibilityState;
  /** Runs the read again, after one that failed or once a purchase landed. */
  retry: () => void;
  isRetrying: boolean;
};

/**
 * The Cloud Agent access answer for the account the form starts the session in:
 * the organization's balance when the form is scoped to one, the person's own
 * otherwise. These are the two procedures the web composer reads
 * (`NewSessionPanel.tsx:186-202`).
 *
 * The balance moves under the form as a purchase lands or a session spends, and
 * the answer decides whether Start is available, so the read is not kept stale
 * for long: the query keeps the client's default stale time and refetches when
 * the app returns to the foreground, which is when a person comes back from
 * buying credits.
 *
 * A read that settles even while the device reports itself offline keeps the
 * answer coming instead of leaving the form waiting on a phase nothing ends
 * (`SETTLE_WHILE_OFFLINE`).
 */
export function useCloudAgentEligibility(
  organizationId: string | undefined
): CloudAgentEligibilityRead {
  const trpc = useTRPC();
  const query = useQuery({
    ...(organizationId
      ? trpc.organizations.cloudAgentNext.checkEligibility.queryOptions(
          { organizationId },
          SETTLE_WHILE_OFFLINE
        )
      : trpc.cloudAgentNext.checkEligibility.queryOptions(undefined, SETTLE_WHILE_OFFLINE)),
  });
  return {
    state: resolveCloudAgentEligibilityState(query satisfies CloudAgentEligibilityQuery),
    retry: () => {
      void query.refetch();
    },
    isRetrying: query.isFetching,
  };
}
