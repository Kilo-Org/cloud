import { type Href, useLocalSearchParams } from 'expo-router';

import { PlatformListScreen } from '@/components/code-reviewer/platform-list-screen';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { parseParam } from '@/lib/route-params';

export default function CodeReviewerScopeRoute() {
  const { scope: rawScope } = useLocalSearchParams<{ scope: string }>();
  const scope = parseParam(rawScope);

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)' as Href} />;
  }

  return <PlatformListScreen scope={scope} />;
}
