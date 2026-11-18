import { Redirect } from 'expo-router';

import { PreparationCopyFixture } from '@/components/agents/preparation-copy-fixture';

export default function PreparationCopyFixtureRoute() {
  return __DEV__ ? <PreparationCopyFixture /> : <Redirect href="/(app)" />;
}
