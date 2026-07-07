import { useLocalSearchParams } from 'expo-router';

import { PlatformOverviewScreen } from '@/components/code-reviewer/platform-overview-screen';
import { asReviewerPlatform } from '@/lib/code-reviewer-config';

export default function CodeReviewerPlatformRoute() {
  const { scope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  return <PlatformOverviewScreen scope={scope} platform={asReviewerPlatform(rawPlatform)} />;
}
