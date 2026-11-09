import { Redirect } from 'expo-router';

import { ButtonLabelFixture } from '@/components/ui/button-label-fixture';

export default function ButtonLabelFixtureRoute() {
  return __DEV__ ? <ButtonLabelFixture /> : <Redirect href="/(auth)/login" />;
}
