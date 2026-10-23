import { useLocalSearchParams } from 'expo-router';

import { ReviewMemoryScreen } from '@/components/code-reviewer/review-memory-screen';

export default function CodeReviewerReviewMemoryRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <ReviewMemoryScreen scope={scope} />;
}
