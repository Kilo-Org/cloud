import { PrReviewConnectGate } from '@/components/pr-review/pr-review-connect-gate';
import { PrReviewEntryScreen } from '@/components/pr-review/pr-review-entry-screen';

export default function PrReviewIndexRoute() {
  return (
    <PrReviewConnectGate>
      <PrReviewEntryScreen />
    </PrReviewConnectGate>
  );
}
