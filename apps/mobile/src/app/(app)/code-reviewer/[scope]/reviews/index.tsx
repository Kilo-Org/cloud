import { type Href, useLocalSearchParams } from 'expo-router';

import { ReviewListScreen } from '@/components/code-reviewer/review-list-screen';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { parseParam } from '@/lib/route-params';

export default function CodeReviewerReviewListRoute() {
  const { scope: rawScope } = useLocalSearchParams<{ scope: string }>();
  const scope = parseParam(rawScope);

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)' as Href} />;
  }

  return <ReviewListScreen scope={scope} />;
}
