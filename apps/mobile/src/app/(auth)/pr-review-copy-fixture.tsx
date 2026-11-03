import { Redirect } from 'expo-router';

import { PrReviewCopyFixture } from '@/components/pr-review/pr-review-copy-fixture';

export default function PrReviewCopyFixtureRoute() {
  return __DEV__ ? <PrReviewCopyFixture /> : <Redirect href="/(auth)/login" />;
}
