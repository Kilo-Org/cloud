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

export type MergeBlockedReasonsModel = {
  reasons: MergeBlockedReason[];
  /**
   * True while the checks read has not answered. The rows are not final yet,
   * so the section holds the panel instead of painting a cause it will
   * replace, and appending a row only after the read never moves the screen.
   */
  isChecksPending: boolean;
};

/**
 * Why the merge section holds the PR back. `failedCheckCount` is the `failure`
 * rollup of the read the Checks card renders, and is `null` until that read
 * answers, so the panel never claims a checks cause the card cannot show.
 */
export function useMergeBlockedReasons(
  overview: PrOverviewDto,
  triple: { owner: string; repo: string; number: number }
): MergeBlockedReasonsModel {
  const queries = useProviderPrQueries(triple);
  const checks = useQuery(queries.checksOptions(overview.headSha, true));
  const isChecksPending = checks.isLoading;
  const failedCheckCount = checks.data ? checks.data.rollup.failure : null;
  const reasons = useMemo(
    () =>
      getMergeBlockedReasons({
        state: overview.state,
        draft: overview.draft,
        mergeable: overview.mergeable,
        mergeableState: overview.mergeableState,
        reviewDecision: overview.reviewDecision,
        failedCheckCount,
        isChecksReadPending: isChecksPending,
        allowUpdateBranch: overview.repo.allowUpdateBranch,
      }),
    [overview, failedCheckCount, isChecksPending]
  );
  return { reasons, isChecksPending };
}
