import { PrReviewConnectGate } from '@/components/pr-review/pr-review-connect-gate';
import { PrReviewEntryScreen } from '@/components/pr-review/pr-review-entry-screen';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export default function PrReviewIndexRoute() {
  useRouteForegroundRefresh([[['githubPrReview']]]);
  return (
    <PrReviewConnectGate>
      <PrReviewEntryScreen />
    </PrReviewConnectGate>
  );
}
