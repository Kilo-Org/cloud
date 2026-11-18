// The connect gate's pending body.
//
// The gate stands in for the whole review surface while the provider status is
// unknown, so a lone centered ActivityIndicator dropped every landmark of the
// screen it guards and read as a different screen rather than a pending one.
// `apps/mobile/AGENTS.md` keeps ActivityIndicator for inline waits and asks a
// data screen's loading state to hold `Skeleton` at the final dimensions, so the
// pending body is the detail screen's own frame: the gate header over the
// overview skeleton the PR read already paints, in the same `px-4` content
// inset, and the gate glides into the review with its silhouette intact.
import { View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { PrReviewGateHeader } from '@/components/pr-review/pr-review-gate-header';
import { PrReviewOverviewSkeleton } from '@/components/pr-review/pr-review-overview-skeleton';

export function PrReviewGateLoading() {
  return (
    <View className="flex-1 bg-background">
      <PrReviewGateHeader />
      <DetailScreenScrollView className="flex-1" contentContainerClassName="px-4">
        <PrReviewOverviewSkeleton />
      </DetailScreenScrollView>
    </View>
  );
}
