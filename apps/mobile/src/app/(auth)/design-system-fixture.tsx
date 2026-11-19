import { Redirect } from 'expo-router';

import { DesignSystemFixture } from '@/components/ui/design-system-fixture';

export default function DesignSystemFixtureRoute() {
  return __DEV__ ? <DesignSystemFixture /> : <Redirect href="/(auth)/login" />;
}
