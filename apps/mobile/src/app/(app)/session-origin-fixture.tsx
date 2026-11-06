import { Redirect } from 'expo-router';

import { SessionOriginFixture } from '@/components/agents/session-origin-fixture';

export default function SessionOriginFixtureRoute() {
  return __DEV__ ? <SessionOriginFixture /> : <Redirect href="/(app)" />;
}
