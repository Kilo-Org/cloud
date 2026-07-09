import { useLocalSearchParams } from 'expo-router';

import { ManualReviewScreen } from '@/components/code-reviewer/manual-review-screen';

export default function CodeReviewerManualReviewRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <ManualReviewScreen scope={scope} />;
}
