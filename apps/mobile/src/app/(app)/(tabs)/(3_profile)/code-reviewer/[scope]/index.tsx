import { useLocalSearchParams } from 'expo-router';

import { ScopeOverviewScreen } from '@/components/code-reviewer/scope-overview-screen';

export default function CodeReviewerScopeRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <ScopeOverviewScreen scope={scope} />;
}
