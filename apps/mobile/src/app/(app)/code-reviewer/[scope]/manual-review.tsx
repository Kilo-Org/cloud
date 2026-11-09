import { type Href, useLocalSearchParams } from 'expo-router';

import { ManualReviewScreen } from '@/components/code-reviewer/manual-review-screen';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { parseParam } from '@/lib/route-params';

export default function CodeReviewerManualReviewRoute() {
  const { scope: rawScope } = useLocalSearchParams<{ scope: string }>();
  const scope = parseParam(rawScope);

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }

  return <ManualReviewScreen scope={scope} />;
}
