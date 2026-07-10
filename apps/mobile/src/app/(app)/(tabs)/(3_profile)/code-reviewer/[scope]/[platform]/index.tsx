import { type Href, useLocalSearchParams } from 'expo-router';

import { PlatformOverviewScreen } from '@/components/code-reviewer/platform-overview-screen';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { parseReviewerPlatform } from '@/lib/code-reviewer-config';
import { parseParam } from '@/lib/route-params';

export default function CodeReviewerPlatformRoute() {
  const { scope: rawScope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const scope = parseParam(rawScope);
  const platform = scope ? parseReviewerPlatform(scope, rawPlatform) : null;

  if (!scope || !platform) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <PlatformOverviewScreen scope={scope} platform={platform} />;
}
