import { Redirect, useLocalSearchParams } from 'expo-router';

import { PrReviewCopyFixture } from '@/components/pr-review/pr-review-copy-fixture';

export default function PrReviewCopyFixtureRoute() {
  const { surface } = useLocalSearchParams<{ surface?: string }>();
  // Keyed by surface: each surface answers the same query keys and builds its
  // own fake read client, so a second surface opened on this route would
  // otherwise keep the first one's client and appear not to change the screen.
  return __DEV__ ? (
    <PrReviewCopyFixture key={surface ?? 'checks'} />
  ) : (
    <Redirect href="/(auth)/login" />
  );
}
