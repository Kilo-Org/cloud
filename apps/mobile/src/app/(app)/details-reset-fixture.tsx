import { Redirect } from 'expo-router';

import { DetailsResetFixture } from '@/components/agents/details-reset-fixture';

export default function DetailsResetFixtureRoute() {
  return __DEV__ ? <DetailsResetFixture /> : <Redirect href="/(auth)/login" />;
}
