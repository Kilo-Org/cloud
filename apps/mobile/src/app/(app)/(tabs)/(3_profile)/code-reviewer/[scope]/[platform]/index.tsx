import { type Href } from 'expo-router';

import { PlatformOverviewScreen } from '@/components/code-reviewer/platform-overview-screen';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { useValidatedReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

export default function CodeReviewerPlatformRoute() {
  const params = useValidatedReviewerRouteParams();

  if (!params) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <PlatformOverviewScreen scope={params.scope} platform={params.platform} />;
}
