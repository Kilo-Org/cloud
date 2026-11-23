import { type Href, useLocalSearchParams } from 'expo-router';

import { ReviewDetailScreen } from '@/components/code-reviewer/review-detail-screen';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { useRetireCoveredSource } from '@/lib/navigation/retire-covered-source';
import { parseParam } from '@/lib/route-params';

// The manual-review form and the two screens it is opened above. No directory
// between this leaf and `(app)/_layout.tsx` is a layout, so Expo Router names
// each of these screens by its path below that Stack — the way the layout
// itself declares `agent-chat/new` and `todos/[list-id]`.
const MANUAL_REVIEW_ROUTE_NAME = 'code-reviewer/[scope]/manual-review';
const REVIEW_LIST_ROUTE_NAME = 'code-reviewer/[scope]/reviews/index';
const SCOPE_OVERVIEW_ROUTE_NAME = 'code-reviewer/[scope]/index';

export default function CodeReviewerReviewDetailRoute() {
  // The create hand-off pushes this screen and retires the form from the form's
  // own listener — which a covered screen never runs. This side owns the retire
  // instead, once per entry the form has: the reviews list it is opened from
  // (`review-list-screen.tsx`) and the scope's platform list
  // (`platform-list-screen.tsx`). Each call removes a form entry directly
  // beneath this screen only when its own list sits under it, so a deep link or
  // any other stack is left alone.
  useRetireCoveredSource(MANUAL_REVIEW_ROUTE_NAME, REVIEW_LIST_ROUTE_NAME);
  useRetireCoveredSource(MANUAL_REVIEW_ROUTE_NAME, SCOPE_OVERVIEW_ROUTE_NAME);
  const { scope: rawScope, id: rawId } = useLocalSearchParams<{ scope: string; id: string }>();
  const scope = parseParam(rawScope);
  const reviewId = parseParam(rawId);

  if (!scope || !reviewId) {
    const backTo = (
      scope ? `/(app)/code-reviewer/${scope}/reviews` : '/(app)/code-reviewer'
    ) as Href;
    return <InvalidRouteState backTo={backTo} />;
  }

  return <ReviewDetailScreen scope={scope} reviewId={reviewId} />;
}
