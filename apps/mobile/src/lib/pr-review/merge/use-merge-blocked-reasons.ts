// The blocked panel's rows, wired to the reads that decide them. Kept out of
// the section so the panel and the Checks card above it read `listChecks`
// through the same query: one answer, two surfaces, no contradiction.

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  getMergeBlockedReasons,
  type MergeBlockedReason,
  type PrOverviewDto,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import { useProviderPrQueries } from '@/lib/pr-review/provider-pr-queries';

/**
 * Why the merge section holds the PR back. `failedCheckCount` is the `failure`
 * rollup of the read the Checks card renders, and stays 0 until that read
 * answers, so the panel never claims a failing check the card cannot show.
 */
export function useMergeBlockedReasons(
  overview: PrOverviewDto,
  triple: { owner: string; repo: string; number: number }
): MergeBlockedReason[] {
  const queries = useProviderPrQueries(triple);
  const checks = useQuery(queries.checksOptions(overview.headSha));
  const failedCheckCount = checks.data?.rollup.failure ?? 0;
  return useMemo(
    () =>
      getMergeBlockedReasons({
        state: overview.state,
        draft: overview.draft,
        mergeable: overview.mergeable,
        mergeableState: overview.mergeableState,
        reviewDecision: overview.reviewDecision,
        failedCheckCount,
        allowUpdateBranch: overview.repo.allowUpdateBranch,
      }),
    [overview, failedCheckCount]
  );
}
