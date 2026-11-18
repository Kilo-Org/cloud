import { Redirect } from 'expo-router';

import { PrReviewEntryFixture } from '@/components/pr-review/pr-review-entry-fixture';

export default function PrReviewEntryFixtureRoute() {
  return __DEV__ ? <PrReviewEntryFixture /> : <Redirect href="/(app)" />;
}
