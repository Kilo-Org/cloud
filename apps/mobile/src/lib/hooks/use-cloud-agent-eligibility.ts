import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import {
  type CloudAgentEligibilityQuery,
  type CloudAgentEligibilityState,
  resolveCloudAgentEligibilityState,
} from '@/lib/cloud-agent-eligibility';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

export type CloudAgentEligibilityRead = {
  state: CloudAgentEligibilityState;
  /**
   * Runs the read again. The query's own stable callback, so a caller can put it
   * in a dependency list without starting a fetch loop.
   */
  refetch: () => void;
  isRetrying: boolean;
};

/**
 * The Cloud Agent access answer for the account the form starts the session in:
 * the organization's balance when the form is scoped to one, the person's own
 * otherwise. These are the two procedures the web composer reads
 * (`NewSessionPanel.tsx:186-202`).
 *
 * The balance moves under the form as credits are bought or a session spends,
 * and the answer decides whether Start is available, so the caller also
 * refetches it when the screen regains focus — the moment a person returns
 * from the credit purchase screen.
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
  // The scope whose read failed, so a retry still reads as a failure while it
  // runs (the query's own status returns to `pending` and drops its error). A
  // different account starts from no failure of its own.
  const { refetch } = query;
  const scope = organizationId ?? null;
  const [failedScope, setFailedScope] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (query.data !== undefined) {
      setFailedScope(undefined);
    } else if (query.isError) {
      setFailedScope(scope);
    }
  }, [query.data, query.isError, scope]);
  return {
    state: resolveCloudAgentEligibilityState({
      data: query.data,
      isPending: query.isPending,
      isError: query.isError,
      isFetching: query.isFetching,
      failedBefore: failedScope === scope,
    } satisfies CloudAgentEligibilityQuery),
    // The query's stable retry underneath, behind a void-returning face so a
    // caller can pass it straight to a press handler or a focus effect: neither
    // uses the promise, and the query reports its own failure through `state`.
    refetch: useCallback(() => {
      void refetch();
    }, [refetch]),
    isRetrying: query.isFetching,
  };
}
