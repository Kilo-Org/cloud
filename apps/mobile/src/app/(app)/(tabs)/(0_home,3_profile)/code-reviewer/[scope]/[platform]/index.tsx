import { useLocalSearchParams } from 'expo-router';

import { PlatformOverviewScreen } from '@/components/code-reviewer/platform-overview-screen';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';

// The `[platform]/_layout.tsx` above already rejects a malformed scope+
// platform combination via InvalidRouteState, so this route never mounts
// with bad params — no need to re-validate.
export default function CodeReviewerPlatformRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();

  return <PlatformOverviewScreen scope={scope} platform={platform} />;
}
