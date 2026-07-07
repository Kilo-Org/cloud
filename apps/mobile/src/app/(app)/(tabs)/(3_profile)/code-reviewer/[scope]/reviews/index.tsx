import { useLocalSearchParams } from 'expo-router';

import { ReviewListScreen } from '@/components/code-reviewer/review-list-screen';

export default function CodeReviewerReviewListRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <ReviewListScreen scope={scope} />;
}
