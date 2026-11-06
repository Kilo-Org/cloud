// The blocked panel's rows, wired to the read that decides them. Kept out of
// the section so the panel and the Checks card above it read `listChecks`
// through the same query: one answer, two surfaces, no contradiction.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  getMergeBlockedReasons,
  type MergeBlockedReason,
  type PrOverviewDto,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import { useProviderPrQueries } from '@/lib/pr-review/provider-pr-queries';

export type MergeBlockedReasonsModel = {
  reasons: MergeBlockedReason[];
};

/**
 * Why the merge section holds the PR back. `failedCheckCount` is the `failure`
 * rollup of the read the Checks card renders, so the panel names failing checks
 * only when that card counts them.
 *
 * The overview paints its body only once this read has answered, and a head
 * change keeps the previous answer on screen the way the card does, so the
 * panel's rows are final at its first frame: it never paints a placeholder the
 * answer then replaces, and never adds a row to a painted panel.
 */
export function useMergeBlockedReasons(
  overview: PrOverviewDto,
  triple: { owner: string; repo: string; number: number }
): MergeBlockedReasonsModel {
  const queries = useProviderPrQueries(triple);
  const checks = useQuery({
    ...queries.checksOptions(overview.headSha, true),
    placeholderData: keepPreviousData,
  });
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
        allowUpdateBranch: overview.repo.allowUpdateBranch,
      }),
    [overview, failedCheckCount]
  );
  return { reasons };
}
