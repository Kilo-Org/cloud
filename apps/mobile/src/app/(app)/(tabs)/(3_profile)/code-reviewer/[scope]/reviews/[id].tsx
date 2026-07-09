import { useLocalSearchParams } from 'expo-router';

import { ReviewDetailScreen } from '@/components/code-reviewer/review-detail-screen';

export default function CodeReviewerReviewDetailRoute() {
  const { scope, id } = useLocalSearchParams<{ scope: string; id: string }>();
  return <ReviewDetailScreen scope={scope} reviewId={id} />;
}
