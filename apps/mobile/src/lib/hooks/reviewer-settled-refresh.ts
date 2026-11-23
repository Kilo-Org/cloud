import { type QueryClient } from '@tanstack/react-query';

import { isPersonal } from '@/lib/code-reviewer-config';
import { orgAuditLogQueryKey } from '@/lib/hooks/use-org-billing-queries';
import { reconcileFirstPage } from '@/lib/query/infinite-retention';

/**
 * The `onSettled` refresh for a code reviewer write that records an audit row:
 * the config read the write changed, then the organization audit log's page one
 * when the scope is an organization (the personal scope writes no organization
 * audit row, so it has none to refresh).
 *
 * The audit read is an infinite query, so it is reconciled rather than
 * invalidated: an invalidation refetches every retained page, while a reconcile
 * re-anchors page one, refetches only that page for a mounted list, and removes
 * an unmounted entry so its next mount reads page one.
 *
 * It lives beside the hooks rather than inside them because `use-code-reviewer`
 * sits at the `max-lines` limit.
 */
export async function settleReviewerWrite(
  queryClient: QueryClient,
  scope: string,
  queryKey: readonly unknown[]
) {
  await queryClient.invalidateQueries({ queryKey });
  if (!isPersonal(scope)) {
    await reconcileFirstPage(queryClient, orgAuditLogQueryKey(scope));
  }
}
