import { Redirect } from 'expo-router';

import { PrReviewGitlabInstanceFixture } from '@/components/pr-review/pr-review-instance-fixture';

export default function PrReviewGitlabInstanceFixtureRoute() {
  return __DEV__ ? <PrReviewGitlabInstanceFixture /> : <Redirect href="/(auth)/login" />;
}
