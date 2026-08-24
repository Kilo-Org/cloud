import { type Href, useLocalSearchParams } from 'expo-router';

import { ReviewDetailScreen } from '@/components/code-reviewer/review-detail-screen';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { parseParam } from '@/lib/route-params';

export default function CodeReviewerReviewDetailRoute() {
  const { scope: rawScope, id: rawId } = useLocalSearchParams<{ scope: string; id: string }>();
  const scope = parseParam(rawScope);
  const reviewId = parseParam(rawId);

  if (!scope || !reviewId) {
    const backTo = (
      scope
        ? `/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/reviews`
        : '/(app)/(tabs)/(3_profile)'
    ) as Href;
    return <InvalidRouteState backTo={backTo} />;
  }

  return <ReviewDetailScreen scope={scope} reviewId={reviewId} />;
}
