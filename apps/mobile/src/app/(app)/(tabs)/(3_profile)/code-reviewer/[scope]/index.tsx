import { useLocalSearchParams } from 'expo-router';

import { PlatformListScreen } from '@/components/code-reviewer/platform-list-screen';

export default function CodeReviewerScopeRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <PlatformListScreen scope={scope} />;
}
