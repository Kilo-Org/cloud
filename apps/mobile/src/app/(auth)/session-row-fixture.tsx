import { Redirect } from 'expo-router';

import { SessionRowFixture } from '@/components/agents/session-row-fixture';

export default function SessionRowFixtureRoute() {
  return __DEV__ ? <SessionRowFixture /> : <Redirect href="/(auth)/login" />;
}
