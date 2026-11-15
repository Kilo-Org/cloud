import { PrReviewEntryScreen } from '@/components/pr-review/pr-review-entry-screen';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

/**
 * The provider-neutral PR-review inbox. It serves all three providers at once,
 * so it mounts no provider gate: a pasted GitLab or Bitbucket link must work for
 * a reader with no GitHub connection, and the gate on any one connection would
 * lock out the other two. The provider gates belong to each detail route.
 */
export default function PrReviewIndexRoute() {
  useRouteForegroundRefresh([[['githubPrReview']]]);
  return <PrReviewEntryScreen />;
}
